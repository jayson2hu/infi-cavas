"""Exercise the built UI with Chrome and a stdio Hono bridge; never open an HTTP listener."""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
import queue
import re
import secrets
import struct
import subprocess
import threading
import time
import zipfile
import zlib
from urllib.parse import unquote, urlsplit

from playwright.sync_api import BrowserContext, Page, Route, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://localhost"


class Bridge:
    def __init__(self, bun: Path, database_url: str, output: Path, with_storage: bool = False):
        self.sequence = 0
        self.answers: queue.Queue = queue.Queue()
        self.lock = threading.Lock()
        self.stderr = (output / "bridge-stderr.log").open("w", encoding="utf-8")
        environment = dict(os.environ, TEST_DATABASE_URL=database_url, BROWSER_TEST_ORIGIN=ORIGIN, BROWSER_TEST_STORAGE=str(with_storage).lower())
        try:
            self.process = subprocess.Popen(
                [str(bun), str(ROOT / "server/scripts/browser-bridge.ts")],
                cwd=ROOT / "server", stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=self.stderr, text=True, encoding="utf-8", bufsize=1, env=environment,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            threading.Thread(target=self._read, daemon=True).start()
            self.info = self.rpc(operation="ping")
        except Exception:
            if hasattr(self, "process") and self.process.poll() is None:
                self.process.terminate()  # Only this harness's own child process.
                self.process.wait(timeout=10)
            self.stderr.close()
            raise

    def _read(self):
        assert self.process.stdout is not None
        for line in self.process.stdout:
            try:
                self.answers.put(json.loads(line))
            except json.JSONDecodeError:
                self.answers.put({"bridgeError": "UnexpectedStdout"})
        self.answers.put({"bridgeError": "BridgeProcessEnded"})

    def rpc(self, **message):
        with self.lock:
            self.sequence += 1
            assert self.process.stdin is not None
            self.process.stdin.write(json.dumps({"id": self.sequence, **message}) + "\n")
            self.process.stdin.flush()
            response = self.answers.get(timeout=30)
            if response.get("bridgeError") or response.get("id") != self.sequence:
                raise RuntimeError(f"验收桥失败：{response.get('bridgeError', 'response ID mismatch')}")
            return response

    def close(self):
        result = None
        try:
            if self.process.poll() is None:
                result = self.rpc(operation="close")
                self.process.wait(timeout=10)
        finally:
            if self.process.poll() is None:
                self.process.terminate()  # Only this harness's own child process.
                self.process.wait(timeout=10)
            self.stderr.close()
        return result


class Acceptance:
    def __init__(self, bridge: Bridge, dist: Path, output: Path):
        self.bridge, self.dist, self.output = bridge, dist.resolve(), output
        self.checks: list[dict] = []
        self.api_requests: list[dict] = []
        self.page_errors: list[str] = []
        self.console_errors: list[str] = []
        self.blocked_external: set[str] = set()
        self.storage_requests: list[dict] = []

    def check(self, name: str, **evidence):
        self.checks.append({"name": name, "passed": True, **evidence})
        print(json.dumps({"check": name, "passed": True}, ensure_ascii=False), flush=True)

    def route(self, route: Route):
        request = route.request
        url = urlsplit(request.url)
        if f"{url.scheme}://{url.netloc}" == self.bridge.info.get("storageOrigin"):
            body = request.post_data_buffer
            response = self.bridge.rpc(
                operation="storage", url=request.url, method=request.method, headers=request.all_headers(),
                bodyBase64=base64.b64encode(body).decode() if body else None,
            )
            self.storage_requests.append({"method": request.method, "status": response["status"]})
            self.fulfill_response(route, response)
            return
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.blocked_external.add(f"{url.scheme}://{url.netloc}{url.path}")
            route.abort("blockedbyclient")
            return
        if url.path.startswith("/api/"):
            body = request.post_data_buffer
            response = self.bridge.rpc(
                url=request.url, method=request.method, headers=request.all_headers(),
                bodyBase64=base64.b64encode(body).decode() if body else None,
            )
            self.api_requests.append({"method": request.method, "path": url.path, "status": response["status"]})
            # Fulfilled synthetic documents have no real server IP, so Chrome classifies a
            # redirected loopback GET as a forbidden private-network transition. Follow only
            # this bridge's real, authorized /files redirect in the transport instead.
            if url.path.startswith("/api/files/") and response["status"] == 302:
                location = next(value for name, value in response["headers"] if name.lower() == "location")
                response = self.bridge.rpc(operation="storage", url=location, method="GET", headers={})
                self.storage_requests.append({"method": "GET", "status": response["status"], "followedAuthorizedRedirect": True})
            self.fulfill_response(route, response)
            return
        if url.path == "/config.js":
            config = {"PLATFORM_API_BASE": "/api", "BRAND_NAME": "画布验收"}
            route.fulfill(status=200, content_type="application/javascript", body=f"window.__RUNTIME_CONFIG__={json.dumps(config, ensure_ascii=False)};")
            return
        relative = unquote(url.path).lstrip("/")
        candidate = (self.dist / relative).resolve()
        try:
            candidate.relative_to(self.dist)
        except ValueError:
            route.fulfill(status=403, body="Forbidden")
            return
        if not candidate.is_file():
            if Path(relative).suffix:
                route.fulfill(status=404, body="Not found")
                return
            candidate = self.dist / "index.html"
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        route.fulfill(status=200, content_type=content_type, headers={"Cache-Control": "no-store"}, body=candidate.read_bytes())

    @staticmethod
    def fulfill_response(route: Route, response: dict):
        headers: dict[str, str] = {}
        for name, value in response["headers"]:
            lower = name.lower()
            headers[lower] = headers.get(lower, "") + ("\n" if lower in headers else "") + value
        # Playwright supplies framing for the fulfilled bytes, rather than reusing transport framing.
        headers.pop("content-length", None)
        headers.pop("transfer-encoding", None)
        route.fulfill(status=response["status"], headers=headers, body=base64.b64decode(response["bodyBase64"]))

    def context(self, browser, width=1440, height=1000) -> BrowserContext:
        context = browser.new_context(viewport={"width": width, "height": height}, locale="zh-CN", service_workers="block")
        context.route("**/*", self.route)
        return context

    def page(self, context: BrowserContext) -> Page:
        page = context.new_page()
        page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        # Browser CORS errors can echo presigned URLs; never persist their query credentials.
        def console(message):
            if message.type == "error":
                sanitized = re.sub(r"https?://[^\s\"']+", lambda match: match.group(0).split("?", 1)[0], message.text)
                self.console_errors.append(sanitized)
        page.on("console", console)
        return page

    def visit(self, page: Page, path: str):
        page.goto(ORIGIN + path)
        page.wait_for_load_state("networkidle")

    def screenshot(self, page: Page, name: str):
        page.screenshot(path=str(self.output / f"{name}.png"), full_page=True)

    def me(self, page: Page):
        return page.evaluate("async () => { const r = await fetch('/api/auth/me'); if (!r.ok) throw new Error('auth/me ' + r.status); return r.json(); }")

    def run(self, browser):
        run_id = secrets.token_hex(6)
        owner_email = f"browser-{run_id}-owner@example.test"
        member_email = f"browser-{run_id}-member@example.test"
        password = secrets.token_urlsafe(24)
        owner_context = self.context(browser)
        owner = self.page(owner_context)
        member_context = None
        try:
            self.visit(owner, "/billing")
            expect(owner).to_have_url(re.compile(r"/login\?redirect="))
            expect(owner.get_by_role("button", name=re.compile(r"登\s*录"))).to_be_visible()
            self.screenshot(owner, "01-login-desktop")
            self.check("未登录访问计费页跳转登录")

            self.visit(owner, "/register?redirect=%2Fbilling")
            owner.get_by_label("姓名", exact=True).fill("浏览器验收所有者")
            owner.get_by_label("邮箱", exact=True).fill(owner_email)
            owner.get_by_label("密码", exact=True).fill(password)
            owner.get_by_role("button", name=re.compile(r"注\s*册")).click()
            expect(owner).to_have_url(ORIGIN + "/billing")
            owner.wait_for_load_state("networkidle")
            expect(owner.get_by_role("heading", name="用量与计费", exact=True)).to_be_visible()
            expect(owner.locator("main .platform-stat").first).to_have_text("200")
            session_cookie = next(cookie for cookie in owner_context.cookies() if cookie["name"] == "ic_session")
            assert session_cookie["httpOnly"], "会话 Cookie 必须 HttpOnly"
            initial = self.me(owner)
            personal_id = initial["currentWorkspaceId"]
            personal_name = next(item["name"] for item in initial["workspaces"] if item["id"] == personal_id)
            self.screenshot(owner, "02-billing-desktop")
            self.check("真实注册、个人工作区、200 点余额与 HttpOnly Cookie", initialBalance=200)

            owner.get_by_role("button", name="切换工作区", exact=True).click()
            owner.get_by_role("menuitem", name="创建团队工作区", exact=True).click()
            dialog = owner.get_by_role("dialog", name="创建团队工作区", exact=True)
            team_name = f"浏览器验收团队 {run_id}"
            dialog.get_by_label("工作区名称", exact=True).fill(team_name)
            dialog.get_by_role("button", name="创建团队工作区", exact=True).click()
            expect(dialog).not_to_be_visible()
            owner.wait_for_load_state("networkidle")
            team = self.me(owner)
            team_id = team["currentWorkspaceId"]
            assert team_id != personal_id
            assert any(item["id"] == team_id and item["kind"] == "team" and item["role"] == "owner" for item in team["workspaces"])
            self.visit(owner, "/team")
            owner.get_by_role("button", name="邀请成员", exact=True).click()
            invite_dialog = owner.get_by_role("dialog", name="邀请成员", exact=True)
            invite_dialog.get_by_role("button", name="生成邀请链接", exact=True).click()
            expect(invite_dialog.get_by_text("邀请链接已生成", exact=True)).to_be_visible()
            invite_url = invite_dialog.get_by_label("邀请链接", exact=True).input_value()
            assert invite_url.startswith(ORIGIN + "/invite/")
            self.screenshot(owner, "03-team-invite")
            owner.keyboard.press("Escape")
            expect(invite_dialog).not_to_be_visible()
            self.check("创建团队、切换工作区并生成邀请链接")

            member_context = self.context(browser, width=390, height=844)
            member = self.page(member_context)
            member.goto(invite_url)
            member.wait_for_load_state("networkidle")
            member.get_by_role("link", name="注册并加入工作区", exact=True).click()
            member.get_by_label("姓名", exact=True).fill("浏览器验收成员")
            member.get_by_label("邮箱", exact=True).fill(member_email)
            member.get_by_label("密码", exact=True).fill(password)
            member.get_by_role("button", name=re.compile(r"注\s*册")).click()
            expect(member).to_have_url(ORIGIN + "/")
            member.wait_for_load_state("networkidle")
            joined = self.me(member)
            assert joined["currentWorkspaceId"] == team_id
            assert any(item["id"] == team_id and item["role"] == "member" for item in joined["workspaces"])
            self.visit(member, "/team")
            expect(member.get_by_role("button", name="邀请成员", exact=True)).to_have_count(0)

            self.visit(owner, "/team")
            member_row = owner.get_by_role("row").filter(has_text=member_email)
            member_row.get_by_role("button", name=re.compile(r"编\s*辑")).click()
            edit_dialog = owner.get_by_role("dialog", name="编辑成员", exact=True)
            edit_dialog.get_by_label("月度上限", exact=True).fill("12")
            edit_dialog.get_by_role("button", name=re.compile(r"保\s*存")).click()
            expect(edit_dialog).not_to_be_visible()
            expect(member_row).to_contain_text("12 点")
            self.screenshot(owner, "04-team-members-desktop")
            self.visit(member, "/billing")
            expect(member.get_by_role("heading", name="成员用量", exact=True)).to_have_count(0)
            expect(member.get_by_role("button", name="导出账单", exact=True)).to_have_count(0)
            forbidden_status = member.evaluate("async () => (await fetch('/api/billing/members')).status")
            assert forbidden_status == 403
            self.check("邀请注册自动加入、管理员设置成员额度、成员 UI 与 API 权限隔离", monthlyCap=12)

            owner.get_by_role("button", name="切换工作区", exact=True).click()
            owner.get_by_role("menuitem", name=personal_name, exact=True).click()
            owner.wait_for_load_state("networkidle")
            self.visit(owner, "/billing")
            with owner.expect_download() as download_event:
                owner.get_by_role("button", name="导出账单", exact=True).click()
            csv_path = self.output / "billing.csv"
            download_event.value.save_as(str(csv_path))
            csv_text = csv_path.read_text(encoding="utf-8-sig")
            assert "发放" in csv_text and "200" in csv_text
            self.check("账本流水导出 CSV 与注册赠点一致")

            owner.set_viewport_size({"width": 390, "height": 844})
            for name, path in [("home", "/"), ("team", "/team"), ("billing", "/billing")]:
                self.visit(owner, path)
                widths = owner.evaluate("({viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth})")
                assert widths["document"] <= widths["viewport"] and widths["body"] <= widths["viewport"], f"{path} 存在页面横向滚动：{widths}"
                self.screenshot(owner, f"05-mobile-{name}")
                self.check(f"390px {path} 无页面横向滚动", **widths)

            owner.get_by_role("button", name="账号菜单", exact=True).click()
            owner.get_by_role("menuitem", name="退出登录", exact=True).click()
            expect(owner).to_have_url(ORIGIN + "/login")
            assert not any(cookie["name"] == "ic_session" and cookie["value"] for cookie in owner_context.cookies())
            self.visit(owner, "/login?redirect=%2Fbilling")
            owner.get_by_label("邮箱", exact=True).fill(owner_email)
            owner.get_by_label("密码", exact=True).fill("wrong-browser-test-password")
            owner.get_by_role("button", name=re.compile(r"登\s*录")).click()
            expect(owner.get_by_text("邮箱或密码错误", exact=True)).to_be_visible()
            owner.get_by_label("密码", exact=True).fill(password)
            owner.get_by_role("button", name=re.compile(r"登\s*录")).click()
            expect(owner).to_have_url(ORIGIN + "/billing")
            owner.wait_for_load_state("networkidle")
            self.check("退出清除 Cookie、错误密码提示与重新登录跳转")
            assert not self.page_errors, f"浏览器运行时异常：{self.page_errors}"
        except Exception:
            if not owner.is_closed():
                self.screenshot(owner, "failure-owner")
                (self.output / "failure-owner.html").write_text(owner.content(), encoding="utf-8")
            raise
        finally:
            if member_context:
                member_context.close()
            owner_context.close()

    def run_brands(self, browser):
        """M3 only: upload real bytes, inspect injection and preserve imported SKU in a ZIP."""
        assert "storageOrigin" in self.bridge.info, "M3 验收必须启用独占测试桶"
        run_id = secrets.token_hex(6)
        password = secrets.token_urlsafe(24)
        context = self.context(browser)
        page = self.page(context)
        outsider_context = None
        def request(path, method="GET", body=None):
            return page.evaluate("""async ({path, method, body}) => {
                const response = await fetch(path, {method, headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
                return {status: response.status, body: response.status === 204 ? null : await response.json()};
            }""", {"path": path, "method": method, "body": body})
        def upload(kind, filename, data):
            section = page.locator("section.platform-card").filter(has=page.get_by_role("heading", name=kind, exact=True))
            section.get_by_role("button", name="上传资产", exact=True).click()
            dialog = page.get_by_role("dialog", name="上传资产", exact=True)
            dialog.locator('input[type="file"]').set_input_files({"name": filename, "mimeType": "image/png", "buffer": data})
            dialog.get_by_role("button", name=re.compile(r"确\s*定")).click()
            expect(dialog).not_to_be_visible(timeout=15000)
            expect(page.get_by_alt_text(filename, exact=True)).to_be_visible()
            page.wait_for_function("name => [...document.images].some(image => image.alt === name && image.complete && image.naturalWidth > 0)", arg=filename)
        def png(color):
            def chunk(kind, body):
                return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff)
            pixels = b"".join(b"\x00" + bytes(color) * 64 for _ in range(64))
            return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
        try:
            self.visit(page, "/register?redirect=%2Fbrand")
            page.get_by_label("姓名", exact=True).fill("品牌浏览器验收")
            page.get_by_label("邮箱", exact=True).fill(f"browser-{run_id}-brand@example.test")
            page.get_by_label("密码", exact=True).fill(password)
            page.get_by_role("button", name=re.compile(r"注\s*册")).click()
            expect(page).to_have_url(ORIGIN + "/brand")
            page.get_by_role("button", name="新建品牌", exact=True).click()
            dialog = page.get_by_role("dialog", name="新建品牌", exact=True)
            brand_name = f"验收品牌 {run_id}"
            dialog.get_by_label("品牌名称", exact=True).fill(brand_name)
            dialog.get_by_label("行业", exact=True).fill("电商")
            dialog.get_by_label("描述", exact=True).fill("浏览器独占验收品牌")
            dialog.locator("#enforced").click()
            dialog.get_by_role("button", name=re.compile(r"保\s*存")).click()
            expect(dialog).not_to_be_visible()
            expect(page).to_have_url(re.compile(r"/brand/brd_"))
            brand_id = page.url.rsplit("/", 1)[1]
            page.get_by_role("button", name="设为默认", exact=True).click()
            expect(page.get_by_role("button", name="取消默认", exact=True)).to_be_visible()
            page.get_by_label("必带描述", exact=True).fill("自然光")
            page.get_by_label("必带描述", exact=True).press("Enter")
            page.get_by_label("避免内容", exact=True).fill("杂乱背景")
            page.get_by_label("避免内容", exact=True).press("Enter")
            expect(page.locator("pre.brand-injection")).to_contain_text("自然光")
            expect(page.locator("pre.brand-injection")).to_contain_text("杂乱背景")
            color_section = page.locator("section.platform-card").filter(has=page.get_by_role("heading", name="品牌色", exact=True))
            color_section.get_by_role("button", name=re.compile(r"编\s*辑")).click()
            colors = page.get_by_role("dialog", name="品牌色", exact=True)
            colors.get_by_role("button", name="添加颜色", exact=True).click()
            colors.get_by_label("姓名", exact=True).fill("墨色")
            colors.get_by_role("button", name=re.compile(r"保\s*存")).click()
            expect(colors).not_to_be_visible()
            expect(page.locator("pre.brand-injection")).to_contain_text("墨色 #1C1917")
            self.check("品牌真实创建、默认品牌、强制套用、规则自动保存及色板预览")

            sku_bytes = png((31, 59, 45))
            upload("Logo", "验收Logo.png", png((85, 46, 41)))
            upload("产品 SKU", "验收商品.png", sku_bytes)
            upload("风格参考", "验收风格.png", png((199, 164, 106)))
            page.get_by_role("switch", name="随生成附带", exact=True).click()
            expect(page.locator("pre.brand-injection")).to_contain_text("[参考图] 风格参考 ×1")
            before = len([item for item in self.api_requests if item["path"].endswith("/injection-preview")])
            example = page.get_by_label("输入示例提示词，查看完整注入结果", exact=True)
            example.fill("商品")
            example.fill("商品展示")
            final_prompt = "商品展示，保留自然光影"
            example.fill(final_prompt)
            expect(page.locator("pre.brand-injection")).to_contain_text(final_prompt)
            preview_requests = len([item for item in self.api_requests if item["path"].endswith("/injection-preview")]) - before
            assert preview_requests == 1, f"快速修改应仅发出一次防抖预览请求，实际 {preview_requests}"
            detail = request(f"/api/brands/{brand_id}")["body"]
            sku = next(asset for asset in detail["assets"] if asset["kind"] == "sku")
            assert sku["width"] == 64 and sku["height"] == 64
            assert "/brands/" in sku["url"] and "/uploads/" not in sku["url"]
            self.screenshot(page, "m3-01-brand-desktop")
            self.check("浏览器直传真实S3、最终资产可显示、风格附带与300ms防抖预览", uploadedImages=3, previewRequests=preview_requests, imageWidth=64)

            outsider_context = self.context(browser)
            outsider = self.page(outsider_context)
            self.visit(outsider, "/register")
            outsider.get_by_label("姓名", exact=True).fill("品牌隔离验收")
            outsider.get_by_label("邮箱", exact=True).fill(f"browser-{run_id}-outsider@example.test")
            outsider.get_by_label("密码", exact=True).fill(password)
            outsider.get_by_role("button", name=re.compile(r"注\s*册")).click()
            expect(outsider).to_have_url(ORIGIN + "/")
            denied = outsider.evaluate("async url => (await fetch(url, {redirect:'manual'})).status", sku["url"])
            assert denied == 403
            self.check("另一账号无工作区请求头读取品牌文件仍被403拒绝")

            page.set_viewport_size({"width": 390, "height": 844})
            page.locator(".platform-workspace-content").evaluate("element => { element.scrollTop = 0; }")
            widths = page.evaluate("({viewport:innerWidth, document:document.documentElement.scrollWidth, body:document.body.scrollWidth})")
            assert widths["document"] <= widths["viewport"] and widths["body"] <= widths["viewport"]
            self.screenshot(page, "m3-02-brand-mobile")
            self.check("390px品牌页无页面横向溢出", **widths)
            page.set_viewport_size({"width": 1440, "height": 1000})
            page.get_by_role("button", name="新建画布", exact=True).click()
            expect(page).to_have_url(re.compile(r"/canvas/[^/]+$"))
            page.get_by_role("button", name="品牌套件", exact=True).click()
            expect(page.get_by_role("region", name="Logo", exact=True).get_by_alt_text("验收Logo.png", exact=True)).to_be_visible()
            reference_region = page.get_by_role("region", name="风格参考", exact=True)
            expect(reference_region.get_by_alt_text("验收风格.png", exact=True)).to_be_visible()
            expect(reference_region.get_by_text("随生成附带", exact=True)).to_be_visible()
            expect(page.get_by_role("region", name="品牌色", exact=True).get_by_title("墨色 #1C1917", exact=True)).to_be_visible()
            rules_region = page.get_by_role("region", name="提示词规则", exact=True)
            expect(rules_region.get_by_text("自然光", exact=True)).to_be_visible()
            expect(rules_region.get_by_text("杂乱背景", exact=True)).to_be_visible()
            self.check("画布品牌侧栏显示真实Logo、风格参考附带状态、品牌色和规则摘要")
            source = page.locator('button[draggable="true"]').filter(has=page.get_by_alt_text("验收商品.png", exact=True))
            expect(source).to_be_visible()
            canvas = page.locator("div.relative.h-full.w-full.select-none.overflow-hidden")
            source.drag_to(canvas, target_position={"x": 650, "y": 420})
            expect(page.locator("[data-node-id]")).to_have_count(1)
            self.screenshot(page, "m3-03-canvas-sku-imported")
            page.get_by_role("button", name="生成配置", exact=True).click()
            expect(page.locator("[data-node-id]")).to_have_count(2)
            toggle = page.get_by_role("switch", name="品牌套件", exact=True)
            expect(toggle).to_be_disabled()
            expect(toggle).to_be_checked()
            self.screenshot(page, "m3-03-canvas-brand-sku")
            self.check("品牌SKU通过实际拖拽创建普通图片节点、强制品牌开关置灰")

            page.get_by_role("button", name="打开画布菜单", exact=True).click()
            with page.expect_download() as event:
                page.get_by_role("menuitem", name="导出当前画布", exact=True).click()
            output = self.output / "brand-canvas.zip"
            event.value.save_as(str(output))
            with zipfile.ZipFile(output) as archive:
                data = json.loads(archive.read("projects.json"))
                exported = data["projects"][0]
                image_nodes = [node for node in exported["project"]["nodes"] if node["type"] == "image"]
                assert len(image_nodes) == 1
                key = image_nodes[0]["metadata"]["storageKey"]
                assert key.startswith("image:")
                local_file = next(item for item in exported["files"] if item["storageKey"] == key)
                assert archive.read(local_file["path"]) == sku_bytes
            self.check("导出ZIP包含普通image节点、IndexedDB图片键和原始SKU字节", imageNodes=1, imageBytes=len(sku_bytes))
            assert not self.page_errors, f"浏览器运行时异常：{self.page_errors}"
            assert any(item["method"] == "PUT" and item["status"] == 200 for item in self.storage_requests)
        except Exception:
            self.screenshot(page, "m3-failure")
            (self.output / "m3-failure.html").write_text(page.content(), encoding="utf-8")
            raise
        finally:
            if outsider_context:
                outsider_context.close()
            context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bun", type=Path, default=ROOT / ".tools/node_modules/@oven/bun-windows-x64/bin/bun.exe")
    parser.add_argument("--chrome", type=Path, default=Path("C:/Program Files/Google/Chrome/Application/chrome.exe"))
    parser.add_argument("--dist", type=Path, default=ROOT / "web/dist")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/acceptance/browser")
    parser.add_argument("--test-database-url", default=os.environ.get("TEST_DATABASE_URL", "postgres://ic@127.0.0.1:55432/ic_test"))
    parser.add_argument("--with-storage", action="store_true", help="Use existing local S3 with an isolated temporary bucket; inherit S3 credentials from environment")
    parser.add_argument("--stage", choices=["m2", "m3"], default="m2")
    args = parser.parse_args()
    if args.stage == "m3" and not args.with_storage:
        parser.error("M3 requires --with-storage")
    if not (args.dist / "index.html").is_file():
        parser.error("web/dist/index.html 不存在；请先完成构建")
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"stage": args.stage, "mode": "built UI + Playwright route.fulfill + stdio Hono app.request", "httpListenerStarted": False, "realProviderCalls": False, "deploymentAcceptance": False, "isolatedStorage": args.with_storage, "fileRedirectsFollowedByTransport": args.with_storage, "passed": False}
    started = time.monotonic()
    bridge = None
    acceptance = None
    try:
        bridge = Bridge(args.bun, args.test_database_url, args.output, with_storage=args.with_storage)
        acceptance = Acceptance(bridge, args.dist, args.output)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=str(args.chrome), headless=True)
            try:
                if args.stage == "m3":
                    acceptance.run_brands(browser)
                else:
                    acceptance.run(browser)
            finally:
                browser.close()
        report["passed"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        if bridge:
            try:
                report["cleanup"] = bridge.close()
            except Exception as error:
                report["passed"] = False
                report["cleanupError"] = f"{type(error).__name__}: {error}"
        if acceptance:
            report.update(checks=acceptance.checks, apiRequests=acceptance.api_requests, storageRequests=acceptance.storage_requests, pageErrors=acceptance.page_errors, consoleErrors=acceptance.console_errors, blockedExternal=sorted(acceptance.blocked_external))
        report["elapsedSeconds"] = round(time.monotonic() - started, 2)
        (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "checks": len(report.get("checks", [])), "report": str((args.output / "report.json").resolve()), "error": report.get("error"), "cleanupError": report.get("cleanupError")}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
