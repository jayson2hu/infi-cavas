"""M4 browser acceptance using an asynchronous, listener-free application bridge."""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import traceback
import wave
import zipfile
from urllib.parse import unquote, urlsplit

from PIL import Image
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://localhost"


def prepare_images(output: Path):
    encoded = []
    for index in range(128):
        picture = Image.new("RGB", (64, 64), ((index * 47) % 256, (index * 89 + 31) % 256, (index * 113 + 79) % 256))
        buffer = io.BytesIO()
        picture.save(buffer, format="PNG")
        encoded.append(base64.b64encode(buffer.getvalue()).decode())
    path = output / "controlled-images.json"
    path.write_text(json.dumps(encoded), encoding="utf-8")
    product = Image.new("RGB", (96, 64), (9, 121, 77))
    product.save(output / "product.png", format="PNG")
    return path


async def prepare_video(browser, output: Path):
    context = await browser.new_context()
    page = await context.new_page()
    try:
        data = await page.evaluate("""async () => {
            const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
            const draw = canvas.getContext('2d'); draw.fillStyle = '#1f3b2d'; draw.fillRect(0, 0, 64, 64);
            const stream = canvas.captureStream(10);
            const recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp8'});
            const chunks = []; recorder.ondataavailable = event => chunks.push(event.data);
            const finished = new Promise(resolve => recorder.onstop = resolve);
            recorder.start();
            for (let frame = 0; frame < 4; frame++) { draw.fillStyle = frame % 2 ? '#c7a46a' : '#1f3b2d'; draw.fillRect(0, 0, 64, 64); await new Promise(resolve => setTimeout(resolve, 100)); }
            recorder.stop(); await finished; stream.getTracks().forEach(track => track.stop());
            const bytes = new Uint8Array(await new Blob(chunks, {type:'video/webm'}).arrayBuffer());
            return btoa(String.fromCharCode(...bytes));
        }""")
        path = output / "controlled.webm"
        path.write_bytes(base64.b64decode(data))
        return path
    finally:
        await context.close()


def prepare_audio(output: Path):
    path = output / "controlled.wav"
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x00\x00" * 1600)
    return path


class AsyncBridge:
    def __init__(self):
        self.sequence = 0
        self.pending = {}

    @classmethod
    async def start(cls, bun: Path, output: Path, images: Path, video: Path, audio: Path, environment_overrides=None, bridge_arguments=None, rpc_timeout=30):
        bridge = cls()
        bridge.rpc_timeout = rpc_timeout
        bridge.stderr = (output / "bridge-stderr.log").open("wb")
        environment = dict(os.environ, TEST_DATABASE_URL="postgres://ic@127.0.0.1:55432/ic_test", BROWSER_TEST_ORIGIN=ORIGIN, BROWSER_TEST_STORAGE="true", BROWSER_TEST_STAGE="m4", BROWSER_TEST_IMAGES=str(images), BROWSER_TEST_VIDEO=str(video), BROWSER_TEST_AUDIO=str(audio))
        if environment_overrides:
            environment.update(environment_overrides)
        try:
            bridge.process = await asyncio.create_subprocess_exec(
                str(bun), str(ROOT / "server/scripts/browser-bridge.ts"), *(bridge_arguments or []), cwd=str(ROOT / "server"),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=bridge.stderr,
                env=environment, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), limit=64 * 1024 * 1024,
            )
            bridge.reader = asyncio.create_task(bridge.read())
            bridge.info = await bridge.rpc(operation="ping")
            return bridge
        except Exception:
            if hasattr(bridge, "process") and bridge.process.returncode is None:
                bridge.process.terminate()
                await bridge.process.wait()
            bridge.stderr.close()
            raise

    async def read(self):
        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    raise RuntimeError("BrowserBridgeEnded")
                value = json.loads(line.decode("utf-8"))
                future = self.pending.get(value.get("id"))
                if future and not future.done():
                    if value.get("bridgeError"):
                        future.set_exception(RuntimeError(value["bridgeError"]))
                    else:
                        future.set_result(value)
        except Exception as error:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)

    async def rpc(self, on_id=None, **message):
        self.sequence += 1
        sequence = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[sequence] = future
        if on_id:
            on_id(sequence)
        try:
            self.process.stdin.write((json.dumps({"id": sequence, **message}) + "\n").encode("utf-8"))
            await self.process.stdin.drain()
            return await asyncio.wait_for(future, self.rpc_timeout)
        finally:
            self.pending.pop(sequence, None)

    async def close(self):
        try:
            result = await self.rpc(operation="close") if self.process.returncode is None else None
            await asyncio.wait_for(self.process.wait(), 10)
            return result
        finally:
            if self.process.returncode is None:
                self.process.terminate()  # Only this harness's own child process.
                await self.process.wait()
            self.reader.cancel()
            self.stderr.close()


class Acceptance:
    def __init__(self, bridge: AsyncBridge, output: Path):
        self.bridge, self.output = bridge, output
        self.dist = (ROOT / "web/dist").resolve()
        self.checks, self.api_requests, self.storage_requests = [], [], []
        self.page_errors, self.console_errors, self.transport_errors = [], [], []
        self.blocked_external = set()
        self.request_ids = {}
        self.cancellations = []
        self.background = set()
        self.closing = False
        self.multipart = {}
        self.model_delay = 0
        self.finish_timeout = 45000

    def check(self, name, **evidence):
        self.checks.append({"name": name, "passed": True, **evidence})
        print(json.dumps({"check": name, "passed": True}, ensure_ascii=False), flush=True)

    async def failed(self, request):
        request_id = self.request_ids.get(id(request._impl_obj))
        if request_id:
            result = await self.bridge.rpc(operation="cancel", requestId=request_id)
            self.cancellations.append({"requestId": request_id, "cancelled": result["cancelled"]})

    async def context(self, browser):
        context = await browser.new_context(viewport={"width": 1600, "height": 1000}, locale="zh-CN", service_workers="block")
        # Chromium's CDP postData omits file parts. Capture exact FormData values before sending;
        # Bun reconstructs HTTP multipart with its own matching boundary and identical File bytes.
        await context.expose_binding("__acceptanceMultipart", lambda _source, key, entries: self.multipart.__setitem__(key, entries))
        await context.add_init_script("""(() => {
            const capture = async form => {
                const key = crypto.randomUUID();
                const entries = await Promise.all([...form.entries()].map(async ([key,value]) => {
                    if (typeof value === 'string') return {key,value};
                    const bytes = new Uint8Array(await value.arrayBuffer());
                    let binary=''; for(let offset=0;offset<bytes.length;offset+=16384) binary+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
                    return {key,name:value.name,mimeType:value.type,base64:btoa(binary)};
                }));
                await window.__acceptanceMultipart(key, entries); return key;
            };
            const originalFetch = window.fetch;
            window.fetch = async function(input, init) {
                if (init?.body instanceof FormData) {
                    const headers = new Headers(init.headers); headers.set('X-Acceptance-Multipart',await capture(init.body));
                    init = {...init,headers};
                }
                return originalFetch.call(this,input,init);
            };
            const originalSend=XMLHttpRequest.prototype.send, originalAbort=XMLHttpRequest.prototype.abort, originalOpen=XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open=function(...args){this.__acceptanceAborted=false; return originalOpen.apply(this,args);};
            XMLHttpRequest.prototype.abort=function(){this.__acceptanceAborted=true; return originalAbort.call(this);};
            XMLHttpRequest.prototype.send=function(body){
                if (!(body instanceof FormData)) return originalSend.call(this,body);
                void capture(body).then(key => {if(this.__acceptanceAborted)return; this.setRequestHeader('X-Acceptance-Multipart',key); originalSend.call(this,body);});
            };
        })();""")
        await context.route("**/*", self.route)
        def failed(request):
            task = asyncio.create_task(self.failed(request))
            self.background.add(task)
            task.add_done_callback(self.background.discard)
        context.on("requestfailed", failed)
        return context

    async def page(self, context):
        page = await context.new_page()
        page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        page.on("console", lambda message: self.console_errors.append(re.sub(r"https?://[^\s\"']+", lambda match: match.group(0).split("?", 1)[0], message.text)) if message.type == "error" else None)
        return page

    async def fulfill(self, route, response):
        headers = {}
        for name, value in response["headers"]:
            lower = name.lower()
            headers[lower] = headers.get(lower, "") + ("\n" if lower in headers else "") + value
        headers.pop("content-length", None)
        headers.pop("transfer-encoding", None)
        await route.fulfill(status=response["status"], headers=headers, body=base64.b64decode(response["bodyBase64"]))

    async def route(self, route):
        request = route.request
        key = id(request._impl_obj)
        url = urlsplit(request.url)
        try:
            origin = f"{url.scheme}://{url.netloc}"
            if origin == self.bridge.info["storageOrigin"]:
                body = request.post_data_buffer
                response = await self.bridge.rpc(operation="storage", url=request.url, method=request.method, headers=await request.all_headers(), bodyBase64=base64.b64encode(body).decode() if body else None, on_id=lambda value: self.request_ids.__setitem__(key, value))
                self.storage_requests.append({"method": request.method, "status": response["status"]})
                await self.fulfill(route, response)
                return
            if origin != ORIGIN:
                self.blocked_external.add(origin + url.path)
                await route.abort("blockedbyclient")
                return
            if url.path.startswith("/api/"):
                if url.path == "/api/gateway/v1/models" and self.model_delay:
                    await asyncio.sleep(self.model_delay)
                body = request.post_data_buffer
                headers = await request.all_headers()
                multipart_id = headers.pop("x-acceptance-multipart", None)
                multipart = self.multipart.pop(multipart_id) if multipart_id else None
                response = await self.bridge.rpc(url=request.url, method=request.method, headers=headers, multipart=multipart, bodyBase64=base64.b64encode(body).decode() if body and multipart is None else None, on_id=lambda value: self.request_ids.__setitem__(key, value))
                self.api_requests.append({"method": request.method, "path": url.path, "status": response["status"]})
                if url.path.startswith("/api/files/") and response["status"] == 302:
                    location = next(value for name, value in response["headers"] if name.lower() == "location")
                    response = await self.bridge.rpc(operation="storage", url=location, method="GET", headers={})
                    self.storage_requests.append({"method": "GET", "status": response["status"], "followedAuthorizedRedirect": True})
                await self.fulfill(route, response)
                return
            if url.path == "/config.js":
                await route.fulfill(status=200, content_type="application/javascript", body='window.__RUNTIME_CONFIG__={"PLATFORM_API_BASE":"/api","BRAND_NAME":"模板验收"};')
                return
            candidate = (self.dist / unquote(url.path).lstrip("/")).resolve()
            try:
                candidate.relative_to(self.dist)
            except ValueError:
                await route.fulfill(status=403, body="Forbidden")
                return
            if not candidate.is_file():
                if Path(url.path).suffix:
                    await route.fulfill(status=404, body="Not found")
                    return
                candidate = self.dist / "index.html"
            await route.fulfill(status=200, content_type=mimetypes.guess_type(candidate.name)[0] or "application/octet-stream", body=candidate.read_bytes())
        except Exception as error:
            if not self.closing and request.failure != "net::ERR_ABORTED":
                self.transport_errors.append(type(error).__name__)
            try:
                await route.abort("failed")
            except Exception:
                pass
        finally:
            self.request_ids.pop(key, None)

    async def api(self, page, path, method="GET", body=None):
        return await page.evaluate("""async ({path,method,body}) => {
            const response = await fetch(path, {method, headers:body ? {'Content-Type':'application/json'} : {}, body:body ? JSON.stringify(body) : undefined});
            return {status:response.status, body:response.status===204 ? null : await response.json()};
        }""", {"path": path, "method": method, "body": body})

    async def trace(self):
        return (await self.bridge.rpc(operation="trace"))["traces"]

    async def wait_trace(self, predicate, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            traces = await self.trace()
            if predicate(traces):
                return traces
            await asyncio.sleep(0.02)
        raise AssertionError("受控供应商轨迹未达到预期状态")

    async def smoke(self, browser):
        """Validate the test transport itself before relying on it for runner assertions."""
        context = await self.context(browser)
        page = await self.page(context)
        try:
            await page.goto(ORIGIN + "/")
            registered = await self.api(page, "/api/auth/register", "POST", {"name": "模板传输验收", "email": f"template-smoke-{secrets.token_hex(6)}@example.test", "password": secrets.token_urlsafe(24)})
            assert registered["status"] == 201
            workspace = registered["body"]["currentWorkspaceId"]
            models = self.bridge.info["fixtureModels"]
            await self.bridge.rpc(operation="control", control={"holdNodeIds": ["smoke-a", "smoke-b"]})
            await page.evaluate("""({workspace,model}) => {
                window.__smokeControllers = [new AbortController(), new AbortController()];
                window.__smokeRequests = ['smoke-a','smoke-b'].map((node,index) => fetch('/api/gateway/v1/images/generations', {
                    method:'POST', signal:window.__smokeControllers[index].signal,
                    headers:{'Content-Type':'application/json','X-IC-Workspace':workspace,'X-IC-Node':node,'X-IC-Source':'canvas'},
                    body:JSON.stringify({model,prompt:'受控并发',n:1,size:'1024x1024'})
                }).then(async response => ({status:response.status,body:await response.json()})).catch(error => ({cancelled:error.name==='AbortError'})));
            }""", {"workspace": workspace, "model": models["image"]})
            await self.wait_trace(lambda rows: sum(row["status"] == "waiting" for row in rows) == 2)
            self.check("验收桥可同时承载两个真实网关请求", waiting=2)
            await page.evaluate("window.__smokeControllers[0].abort()")
            await self.wait_trace(lambda rows: any(row.get("nodeId") == "smoke-a" and row["status"] == "cancelled" for row in rows))
            await self.bridge.rpc(operation="control", control={"release": True})
            outcomes = await page.evaluate("Promise.all(window.__smokeRequests)")
            assert outcomes[0]["cancelled"] and outcomes[1]["status"] == 200
            summary = (await self.api(page, "/api/billing/summary"))["body"]
            assert summary["balance"] == 1996
            self.check("浏览器Abort传到真实网关并退款，另一并发任务仅扣4点", balance=summary["balance"])
            await self.bridge.rpc(operation="control", control={"failNodeIds": ["smoke-fail"]})
            failed = await page.evaluate("""({model}) => fetch('/api/gateway/v1/images/generations', {method:'POST', headers:{'Content-Type':'application/json','X-IC-Node':'smoke-fail'},body:JSON.stringify({model,prompt:'受控失败',n:1})}).then(response => response.status)""", {"model": models["image"]})
            assert failed == 500
            assert (await self.api(page, "/api/billing/summary"))["body"]["balance"] == 1996
            self.check("受控失败走真实网关退款")
            streamed = await page.evaluate("""({model}) => fetch('/api/gateway/v1/responses', {method:'POST',headers:{'Content-Type':'application/json','X-IC-Node':'smoke-text'},body:JSON.stringify({model,input:'受控文本',stream:true})}).then(response => response.text())""", {"model": models["text"]})
            assert "response.completed" in streamed and "受控模板文本" in streamed
            assert (await self.api(page, "/api/billing/summary"))["body"]["balance"] == 1995
            self.check("受控SSE经过真实解析与结算扣1点")
            created = await self.api(page, "/api/gateway/v1/videos", "POST", {"model": models["video"], "prompt": "受控视频", "seconds": 1})
            assert created["status"] == 200
            task_id = created["body"]["id"]
            polled = await self.api(page, f"/api/gateway/v1/videos/{task_id}")
            assert polled["body"]["status"] == "completed"
            content = await page.evaluate("""async path => { const response = await fetch(path); return {status:response.status,type:response.headers.get('Content-Type'),bytes:(await response.arrayBuffer()).byteLength}; }""", f"/api/gateway/v1/videos/{task_id}/content")
            assert content["status"] == 200 and content["type"] == "video/webm" and content["bytes"] > 100
            self.check("本地生成WebM经过真实视频任务、轮询和内容路由", videoBytes=content["bytes"])
            speech = await page.evaluate("""async model => { const response = await fetch('/api/gateway/v1/audio/speech', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,input:'受控语音',voice:'alloy'})}); return {status:response.status,type:response.headers.get('Content-Type'),bytes:(await response.arrayBuffer()).byteLength}; }""", models["audio"])
            assert speech["status"] == 200 and speech["type"] == "audio/wav" and speech["bytes"] > 100
            self.check("本地WAV经过真实语音网关与归档", audioBytes=speech["bytes"])
            edited = await page.evaluate("""async ({model,bytes}) => { const form=new FormData(); form.set('model',model); form.set('prompt','multipart验收'); form.set('n','1'); form.set('image',new File([Uint8Array.from(atob(bytes),char=>char.charCodeAt(0))],'product.png',{type:'image/png'})); const response=await fetch('/api/gateway/v1/images/edits',{method:'POST',body:form}); return {status:response.status,body:await response.json()}; }""", {"model": models["image"], "bytes": base64.b64encode((self.output / "product.png").read_bytes()).decode()})
            assert edited["status"] == 200, edited
            original_hash = hashlib.sha256((self.output / "product.png").read_bytes()).hexdigest()
            assert (await self.trace())[-1]["inputHashes"] == [original_hash]
            self.check("CDP multipart文件传输适配后图片字节SHA256保持一致", imageHash=original_hash)
            assert not self.transport_errors, self.transport_errors
            assert not self.page_errors, self.page_errors
        finally:
            await context.close()

    async def export(self, page, name):
        await page.get_by_role("button", name="打开画布菜单", exact=True).click()
        async with page.expect_download() as event:
            await page.get_by_role("menuitem", name="导出当前画布", exact=True).click()
        output = self.output / f"{name}.zip"
        await (await event.value).save_as(str(output))
        with zipfile.ZipFile(output) as archive:
            data = json.loads(archive.read("projects.json"))["projects"][0]
            files = {item["storageKey"]: archive.read(item["path"]) for item in data["files"]}
        return data["project"], files

    async def begin(self, page):
        bar = page.locator("[data-template-run-bar]")
        await bar.get_by_role("button", name=re.compile("运行全部|继续运行")).click()
        dialog = page.get_by_role("dialog", name="运行模板流程", exact=True)
        await expect(dialog).to_be_visible()
        await dialog.get_by_role("button", name="运行全部", exact=True).click()
        await expect(dialog).not_to_be_visible()

    async def setup_brand(self, page):
        brand = await self.api(page, "/api/brands", "POST", {"name": "模板验收品牌", "industry": "电商", "requiredTerms": ["验收品牌一致性"], "avoidTerms": ["未提供的功效"]})
        assert brand["status"] == 201
        product = (self.output / "product.png").read_bytes()
        signed = await self.api(page, "/api/uploads/presign", "POST", {"purpose": "brand_asset", "mimeType": "image/png", "bytes": len(product)})
        assert signed["status"] == 200
        uploaded = await page.evaluate("""async ({signed,bytes}) => (await fetch(signed.uploadUrl,{method:'PUT',headers:signed.headers,credentials:'omit',body:Uint8Array.from(atob(bytes),char=>char.charCodeAt(0))})).status""", {"signed": signed["body"], "bytes": base64.b64encode(product).decode()})
        assert uploaded == 200
        sku = await self.api(page, f'/api/brands/{brand["body"]["id"]}/assets', "POST", {"kind": "sku", "objectKey": signed["body"]["objectKey"], "title": "模板验收商品.png"})
        assert sku["status"] == 201
        session = (await self.api(page, "/api/auth/me"))["body"]
        workspace = session["currentWorkspaceId"]
        updated = await self.api(page, f"/api/workspaces/{workspace}", "PATCH", {"defaultBrandId": brand["body"]["id"]})
        assert updated["status"] == 200

    async def insert(self, page, fixture, name, sku=False, defaults=False, open_library=True, variable_values=None):
        if open_library:
            await page.goto(ORIGIN + "/templates")
            await page.wait_for_load_state("networkidle")
            await page.locator(f'.template-card[data-template-id="{fixture["id"]}"]').click()
        detail = page.locator("aside.template-detail")
        await expect(detail.get_by_role("heading", name=fixture["name"], exact=True)).to_be_visible()
        template = (await self.api(page, f'/api/templates/{fixture["id"]}'))["body"]
        summary_before = (await self.api(page, "/api/billing/summary"))["body"]
        balance = summary_before["balance"]
        trace_count = len(await self.trace())
        values = {}
        for variable in template["body"]["variables"]:
            if defaults:
                continue
            if variable["type"] == "image":
                await expect(detail.get_by_role("button", name="在新画布中使用", exact=True)).to_be_disabled()
                if sku:
                    await detail.get_by_role("button", name="从品牌 SKU 选择", exact=True).click()
                    dialog = page.get_by_role("dialog", name="从品牌 SKU 选择", exact=True)
                    await dialog.locator("button").filter(has=page.get_by_alt_text("模板验收商品.png", exact=True)).click()
                    await expect(dialog).not_to_be_visible()
                else:
                    await detail.locator('input[type="file"]').set_input_files(str(self.output / "product.png"))
                await expect(detail.get_by_alt_text(variable["label"], exact=True)).to_be_visible()
            elif variable["type"] == "select":
                values[variable["key"]] = (variable_values or {}).get(variable["key"], variable["options"][-1])
                await detail.locator(f'#template-var-{variable["key"]}').click()
                await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").get_by_title(values[variable["key"]], exact=True).click()
            else:
                values[variable["key"]] = (variable_values or {}).get(variable["key"], f'验收{variable["label"]}：桂花乌龙，已提供的真实参数')
                await detail.locator(f'#template-var-{variable["key"]}').fill(values[variable["key"]])
        await detail.get_by_role("heading", name=fixture["name"], exact=True).click()
        await expect(page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")).to_have_count(0)
        await expect(detail.get_by_role("button", name="在新画布中使用", exact=True)).to_be_enabled()
        if name == "ecom-upload":
            await page.screenshot(path=str(self.output / "m4-01-template-detail.png"), full_page=True)
            await page.set_viewport_size({"width": 390, "height": 844})
            await page.wait_for_function("document.documentElement.scrollWidth <= innerWidth", timeout=5000)
            widths = await page.evaluate("({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth})")
            assert widths["document"] <= widths["viewport"] and widths["body"] <= widths["viewport"], widths
            await page.screenshot(path=str(self.output / "m4-02-templates-mobile.png"), full_page=True)
            await detail.scroll_into_view_if_needed()
            await page.screenshot(path=str(self.output / "m4-03-template-detail-mobile.png"), full_page=True)
            self.check("390px模板中心与变量详情无页面横向溢出", **widths)
            await page.set_viewport_size({"width": 1600, "height": 1000})
        await detail.get_by_role("button", name="在新画布中使用", exact=True).click()
        await expect(page).to_have_url(re.compile(r"/canvas/[^/]+$"))
        await expect(page.locator("[data-template-run-bar]")).to_contain_text("待运行")
        project, files = await self.export(page, name + "-inserted")
        group = next(node for node in project["nodes"] if node.get("metadata", {}).get("templateRun"))
        run = group["metadata"]["templateRun"]
        assert len(run["idMap"]) == sum(op["type"] == "add_node" for op in template["body"]["ops"])
        assert set(run["idMap"]).isdisjoint(run["idMap"].values())
        assert (await self.api(page, f'/api/templates/{fixture["id"]}'))["body"]["useCount"] == template["useCount"] + 1
        assert (await self.api(page, "/api/billing/summary"))["body"] == summary_before
        assert len(await self.trace()) == trace_count
        for value in values.values():
            assert value in json.dumps(project, ensure_ascii=False)
        for variable in template["body"]["variables"]:
            if variable["type"] == "image":
                node = next(node for node in project["nodes"] if node["id"] == run["idMap"][variable["bindNode"]])
                assert files[node["metadata"]["storageKey"]] == (self.output / "product.png").read_bytes()
        self.check(f'{fixture["name"]}：插入、变量、唯一ID、use_count且不扣点', input="SKU" if sku else "defaults" if defaults else "upload/text", templateId=fixture["id"], nodeCount=len(project["nodes"]))
        return template, project, run, balance

    async def finish(self, page, name, run):
        await page.wait_for_function("() => /已完成|失败待重试|已停止/.test(document.querySelector('[data-template-run-bar]')?.textContent || '')", timeout=self.finish_timeout)
        await expect(page.locator("[data-template-run-bar]")).to_contain_text("已完成", timeout=self.finish_timeout)
        project, files = await self.export(page, name + "-completed")
        state = next(node["metadata"]["templateRun"] for node in project["nodes"] if node.get("metadata", {}).get("templateRun"))
        expected = {run["idMap"][local] for step in run["steps"] for local in step["nodeIds"]}
        assert state["status"] == "completed" and set(state["completedNodeIds"]) == expected
        for node in project["nodes"]:
            if node["id"] not in expected:
                continue
            metadata = node.get("metadata", {})
            assert metadata.get("content"), (node["title"], metadata)
            if node["type"] in ["image", "video", "audio"]:
                assert metadata.get("storageKey") in files, (node["title"], metadata)
        await page.keyboard.press("Escape")
        await page.get_by_role("button", name="重置视图", exact=True).click()
        await page.get_by_role("slider", name="放大/缩小画布", exact=True).click(position={"x": 14, "y": 8})
        await page.screenshot(path=str(self.output / f"m4-{name}-complete.png"), full_page=True)
        self.check(f'{name}：全部真实画布步骤完成并可导出结果', completedNodes=len(expected), exportedFiles=len(files))
        return project, files

    async def run(self, browser):
        context = await self.context(browser)
        page = await self.page(context)
        try:
            await page.goto(ORIGIN + "/register?redirect=%2Ftemplates")
            await page.get_by_label("姓名", exact=True).fill("模板浏览器验收")
            await page.get_by_label("邮箱", exact=True).fill(f"templates-{secrets.token_hex(6)}@example.test")
            await page.get_by_label("密码", exact=True).fill(secrets.token_urlsafe(24))
            await page.get_by_role("button", name=re.compile(r"注\s*册")).click()
            await expect(page).to_have_url(ORIGIN + "/templates")
            await self.setup_brand(page)
            fixtures = {item["sourceTemplateId"]: item for item in self.bridge.info["fixtureTemplates"]}
            assert len(fixtures) == 6 and all(item["onlyModelIdsSubstituted"] for item in fixtures.values())
            self.check("六套官方定义副本只替换同能力模型ID，独占资源可清理")
            ecom = fixtures["tpl_ecom_main_set"]
            _, _, _, _ = await self.insert(page, ecom, "ecom-upload")
            await page.locator("[data-template-run-bar]").get_by_role("button", name="撤销插入", exact=True).click()
            await expect(page.locator("[data-template-run-bar]")).to_have_count(0)
            empty, _ = await self.export(page, "ecom-undone")
            assert not empty["nodes"] and not empty["connections"]
            self.check("单次撤销完整移除模板节点、分组与连线")
            _, _, run, before = await self.insert(page, ecom, "ecom-sku", sku=True)
            await self.begin(page)
            project, files = await self.finish(page, "ecom", run)
            traces = [row for row in await self.trace() if row.get("nodeId") in run["idMap"].values()]
            scene = next(node for node in project["nodes"] if node["id"] == run["idMap"]["scene"])
            primary_hash = hashlib.sha256(files[scene["metadata"]["storageKey"]]).hexdigest()
            original_hash = hashlib.sha256((self.output / "product.png").read_bytes()).hexdigest()
            assert primary_hash != original_hash
            scene_traces = [row for row in traces if row.get("nodeId") == run["idMap"]["scene"]]
            assert sum(len(row["outputHashes"]) for row in scene_traces) == 5
            assert primary_hash in [value for row in scene_traces for value in row["outputHashes"]]
            sizes = [row for row in traces if row.get("nodeId") in [run["idMap"][key] for key in ["size_tb", "size_dy", "size_xhs"]]]
            assert len(sizes) == 3 and all(row["inputHashes"] == [primary_hash] for row in sizes), sizes
            assert {row["size"] for row in sizes} == {"1024x1024", "1088x1920", "1248x1664"}
            assert sum(len(row["outputHashes"]) for row in traces) == 8
            after = (await self.api(page, "/api/billing/summary"))["body"]["balance"]
            assert before - after == 40, (before, after)
            self.check("电商5张候选和3种尺寸共8图，后续确实读取生成主图，实际扣40点", primaryHash=primary_hash, originalHash=original_hash, outputImages=8, credits=40)
            await self.save_and_reinsert(page, run)
            for source, name in [("tpl_product_detail_long", "detail"), ("tpl_short_video_storyboard", "video"), ("tpl_brand_campaign_poster", "poster"), ("tpl_social_xhs_set", "social"), ("tpl_store_materials", "store")]:
                _, _, run, balance = await self.insert(page, fixtures[source], name)
                if name == "detail":
                    await self.bridge.rpc(operation="control", control={"failNodeIds": [run["idMap"]["benefits"]]})
                    await self.begin(page)
                    await expect(page.locator("[data-template-run-bar]")).to_contain_text("失败待重试", timeout=30000)
                    initial = [row for row in await self.trace() if row.get("nodeId") in run["idMap"].values()]
                    assert not any(row.get("nodeId") == run["idMap"]["long"] for row in initial)
                    assert any(row.get("nodeId") == run["idMap"]["benefits"] and row["status"] == "failed" for row in initial)
                    successful = {run["idMap"][key]: sum(row.get("nodeId") == run["idMap"][key] for row in initial) for key in ["copy", "hero", "specs"]}
                    await self.begin(page)
                    await self.finish(page, name, run)
                    final = [row for row in await self.trace() if row.get("nodeId") in run["idMap"].values()]
                    assert all(sum(row.get("nodeId") == node for row in final) == count for node, count in successful.items())
                    assert sum(row.get("nodeId") == run["idMap"]["benefits"] for row in final) == 2
                    self.check("并行步骤单点失败停止下游；继续只重试失败节点并保留已成功节点")
                elif name == "video":
                    held = [run["idMap"][key] for key in ["script", "narration"]]
                    await self.bridge.rpc(operation="control", control={"holdNodeIds": held})
                    await self.begin(page)
                    await self.wait_trace(lambda rows: sum(row.get("nodeId") in held and row["status"] == "waiting" for row in rows) == 2)
                    await page.locator("[data-template-run-bar]").get_by_role("button", name="停止", exact=True).click()
                    await expect(page.locator("[data-template-run-bar]")).to_contain_text("已停止", timeout=15000)
                    await self.wait_trace(lambda rows: sum(row.get("nodeId") in held and row["status"] == "cancelled" for row in rows) == 2)
                    assert (await self.api(page, "/api/billing/summary"))["body"]["balance"] == balance
                    await self.bridge.rpc(operation="control", control={"release": True})
                    await page.reload()
                    await expect(page.locator("[data-template-run-bar]")).to_contain_text("已停止")
                    await self.begin(page)
                    await self.finish(page, name, run)
                    self.check("同一步两节点真实并发；停止均Abort退款；刷新后继续文本、图片、视频、语音链路", cancellations=2)
                else:
                    await self.begin(page)
                    await self.finish(page, name, run)
                actual_cost = balance - (await self.api(page, "/api/billing/summary"))["body"]["balance"]
                expected_cost = {"detail": 21, "video": 171, "poster": 9, "social": 25, "store": 17}[name]
                assert actual_cost == expected_cost, (name, actual_cost, expected_cost)
                self.check(f'{name}：真实结算与成功输出一致，失败或取消未重复收费', chargedCredits=actual_cost)
            assert not self.page_errors, self.page_errors
            assert not self.transport_errors, self.transport_errors
        except Exception:
            await page.screenshot(path=str(self.output / "m4-failure.png"), full_page=True)
            (self.output / "m4-failure.html").write_text(await page.content(), encoding="utf-8")
            raise
        finally:
            await context.close()

    async def save_and_reinsert(self, page, original_run):
        await page.keyboard.press("Escape")
        await page.keyboard.press("Control+a")
        await page.get_by_role("button", name="打开画布菜单", exact=True).click()
        await page.get_by_role("menuitem", name="保存为团队模板", exact=True).click()
        dialog = page.get_by_role("dialog", name="保存为团队模板", exact=True)
        name = "验收保存的电商流程"
        await dialog.get_by_label("模板名称", exact=True).fill(name)
        await dialog.get_by_label("说明", exact=True).fill("包含变量与真实永久图片，生成结果不进入模板")
        await dialog.get_by_role("checkbox", name="商品白底图", exact=True).check()
        await dialog.get_by_role("checkbox", name="卖点", exact=True).check()
        await dialog.get_by_role("button", name="保存为团队模板", exact=True).click()
        await expect(dialog).not_to_be_visible(timeout=15000)
        matches = (await self.api(page, "/api/templates?scope=team"))["body"]
        saved = next(item for item in matches if item["name"] == name)
        detail = (await self.api(page, f'/api/templates/{saved["id"]}'))["body"]
        body = detail["body"]
        assert len(body["variables"]) == 2
        assert all(variable.get("default") for variable in body["variables"])
        assert any(variable["type"] == "image" and "/templates/" in variable["default"] for variable in body["variables"])
        generated = {node for step in body["steps"] for node in step["nodeIds"]}
        for op in body["ops"]:
            if op["type"] != "add_node":
                continue
            assert not set(op.get("metadata", {})).intersection({"storageKey", "images", "texts", "templateRun", "status", "platformContext", "apiKey"})
            if op["id"] in generated:
                assert not op.get("metadata", {}).get("content")
        _, _, run, balance = await self.insert(page, saved, "saved", defaults=True)
        assert set(run["idMap"].values()).isdisjoint(original_run["idMap"].values())
        await self.begin(page)
        await self.finish(page, "saved", run)
        assert balance - (await self.api(page, "/api/billing/summary"))["body"]["balance"] == 40
        self.check("已执行流程保存为团队模板；永久图片与文本默认值重用；清除历史输出后新ID再次完整运行")

    async def video_recovery(self, browser):
        context = await self.context(browser)
        page = await self.page(context)
        try:
            await page.goto(ORIGIN + "/register?redirect=%2Ftemplates")
            await page.get_by_label("姓名", exact=True).fill("视频恢复验收")
            await page.get_by_label("邮箱", exact=True).fill(f"video-recovery-{secrets.token_hex(6)}@example.test")
            await page.get_by_label("密码", exact=True).fill(secrets.token_urlsafe(24))
            await page.get_by_role("button", name=re.compile(r"注\s*册")).click()
            await expect(page).to_have_url(ORIGIN + "/templates")
            fixture = next(item for item in self.bridge.info["fixtureTemplates"] if item["sourceTemplateId"] == "tpl_short_video_storyboard")
            for early in [True, False]:
                name = "video-resume-pending" if early else "video-resume-completed"
                _, _, run, balance = await self.insert(page, fixture, name)
                trace_start = len(await self.trace())
                await self.bridge.rpc(operation="control", control={"holdVideoPolls": True})
                await self.begin(page)
                await self.wait_trace(lambda rows: sum(row["status"] == "waiting" and re.fullmatch(r"videos/[^/]+", row["endpoint"]) is not None for row in rows[trace_start:]) == 3, seconds=20)
                pending, _ = await self.export(page, name + "-before-refresh")
                videos = [node for node in pending["nodes"] if node["type"] == "video"]
                task_ids = {node["id"]: node["metadata"].get("videoTaskId") for node in videos}
                assert len(videos) == 3 and all(task_ids.values())
                self.model_delay = 0 if early else 0.75
                await page.reload()
                await expect(page.locator("[data-template-run-bar]")).to_contain_text("已停止", timeout=15000)
                if early:
                    await self.begin(page)
                    await expect(page.locator("[data-template-run-bar]")).to_contain_text("正在运行")
                    await self.bridge.rpc(operation="control", control={"release": True})
                else:
                    await self.bridge.rpc(operation="control", control={"release": True})
                    await expect(page.locator("video")).to_have_count(3, timeout=20000)
                    recovered, _ = await self.export(page, name + "-auto-recovered")
                    state = next(node["metadata"]["templateRun"] for node in recovered["nodes"] if node.get("metadata", {}).get("templateRun"))
                    assert all(node_id in state["completedNodeIds"] for node_id in task_ids), state
                    assert state["status"] == "stopped"
                    await self.begin(page)
                completed, files = await self.finish(page, name, run)
                traces = (await self.trace())[trace_start:]
                creates = [row for row in traces if row["endpoint"] == "videos"]
                assert len(creates) == 3, [(row["endpoint"], row.get("nodeId")) for row in traces]
                video_balance = (await self.api(page, "/api/billing/summary"))["body"]["balance"]
                assert balance - video_balance == 171, (balance, video_balance)
                for key in ["clip1", "clip2", "clip3"]:
                    node = next(node for node in completed["nodes"] if node["id"] == run["idMap"][key])
                    assert files[node["metadata"]["storageKey"]][:4] == bytes([0x1a, 0x45, 0xdf, 0xa3])
                self.check("视频刷新后" + ("轮询未完成时继续复用任务" if early else "自动恢复成功后继续跳过视频") + "，仅创建3任务且整套仅扣171点", videoTasks=3, chargedCredits=171, originalTaskIds=list(task_ids.values()))
            assert not self.page_errors, self.page_errors
            assert not self.transport_errors, self.transport_errors
        except Exception:
            await page.screenshot(path=str(self.output / "m4-failure.png"), full_page=True)
            (self.output / "m4-failure.html").write_text(await page.content(), encoding="utf-8")
            await self.export(page, "video-recovery-failure-state")
            raise
        finally:
            await self.bridge.rpc(operation="control", control={"release": True})
            await context.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/acceptance/browser-m4")
    parser.add_argument("--transport-smoke", action="store_true")
    parser.add_argument("--video-recovery", action="store_true")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"stage": "m4", "transportSmoke": args.transport_smoke, "passed": False, "httpListenerStarted": False, "realProviderCalls": False, "controlledProvider": True, "deploymentAcceptance": False, "fileRedirectsFollowedByTransport": True, "multipartFileBytesPreservedByTransport": True}
    report["videoRecovery"] = args.video_recovery
    report["buildAssets"] = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', (ROOT / "web/dist/index.html").read_text(encoding="utf-8"))
    started = time.monotonic()
    bridge = acceptance = None
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe", headless=True)
            try:
                images = prepare_images(args.output)
                video = await prepare_video(browser, args.output)
                bridge = await AsyncBridge.start(ROOT / ".tools/node_modules/@oven/bun-windows-x64/bin/bun.exe", args.output, images, video, prepare_audio(args.output))
                report["fixtureTemplates"] = bridge.info["fixtureTemplates"]
                report["fixtureModels"] = bridge.info["fixtureModels"]
                acceptance = Acceptance(bridge, args.output)
                if args.transport_smoke:
                    await acceptance.smoke(browser)
                elif args.video_recovery:
                    await acceptance.video_recovery(browser)
                else:
                    await acceptance.run(browser)
                report["passed"] = True
            finally:
                if acceptance:
                    acceptance.closing = True
                await browser.close()
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        report["traceback"] = traceback.format_exc()
    finally:
        if acceptance:
            if acceptance.background:
                await asyncio.gather(*acceptance.background, return_exceptions=True)
            report.update(checks=acceptance.checks, apiRequests=acceptance.api_requests, storageRequests=acceptance.storage_requests, pageErrors=acceptance.page_errors, consoleErrors=acceptance.console_errors, transportErrors=acceptance.transport_errors, cancellations=acceptance.cancellations, blockedExternal=sorted(acceptance.blocked_external))
        if bridge:
            try:
                report["providerTrace"] = await acceptance.trace() if acceptance else []
                report["cleanup"] = await bridge.close()
            except Exception as error:
                report["passed"] = False
                report["cleanupError"] = f"{type(error).__name__}: {error}"
        report["elapsedSeconds"] = round(time.monotonic() - started, 2)
        (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "checks": len(report.get("checks", [])), "report": str(args.output / "report.json"), "error": report.get("error"), "cleanupError": report.get("cleanupError")}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
