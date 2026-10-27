"""M5 final acceptance: real UI/app/PG/S3 with controlled providers, no HTTP listener."""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import re
import secrets
import time
import traceback
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright, expect
from templates_browser_acceptance import Acceptance, AsyncBridge, ROOT, ORIGIN, prepare_audio, prepare_images, prepare_video

BYOK_ORIGIN = "https://browser-byok.invalid"


class FinalAcceptance(Acceptance):
    def __init__(self, bridge, output, mode, email):
        super().__init__(bridge, output)
        self.mode, self.email = mode, email
        self.byok_key = secrets.token_urlsafe(30)
        self.byok_requests = []

    async def route(self, route):
        request = route.request
        target = urlsplit(request.url)
        if target.path == "/config.js" and target.netloc == "localhost":
            config = {"PLATFORM_API_BASE": "" if self.mode == "web-only" else "/api", "BRAND_NAME": "最终验收"}
            await route.fulfill(status=200, content_type="application/javascript", body="window.__RUNTIME_CONFIG__=" + json.dumps(config) + ";")
            return
        if f"{target.scheme}://{target.netloc}" == BYOK_ORIGIN:
            headers = await request.all_headers()
            response_headers = {"Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS"}
            if request.method == "OPTIONS":
                await route.fulfill(status=204, headers=response_headers)
                return
            if target.path == "/v1/models":
                await route.fulfill(status=200, headers=response_headers, json={"data": [{"id": "byok-image", "object": "model"}]})
                return
            body = request.post_data_json
            self.byok_requests.append({"path": target.path, "method": request.method, "prompt": body.get("prompt", ""), "keys": sorted(body), "platformHeaders": sorted(key for key in headers if key.startswith("x-ic-")), "cookieSent": "cookie" in headers, "keyMatched": headers.get("authorization") == "Bearer " + self.byok_key})
            assert target.path == "/v1/images/generations" and request.method == "POST"
            assert headers.get("authorization") == "Bearer " + self.byok_key
            png = json.loads((self.output / "controlled-images.json").read_text(encoding="utf-8"))[67]
            await route.fulfill(status=200, headers=response_headers, json={"data": [{"b64_json": png}]})
            return
        await super().route(route)

    async def register(self, page):
        await page.goto(ORIGIN + "/register")
        await page.get_by_label("姓名", exact=True).fill("最终浏览器验收")
        await page.get_by_label("邮箱", exact=True).fill(self.email)
        await page.get_by_label("密码", exact=True).fill(secrets.token_urlsafe(24))
        await page.get_by_role("button", name=re.compile(r"注\s*册")).click()
        await expect(page).to_have_url(ORIGIN + "/")
        await page.wait_for_load_state("networkidle")
        return (await self.api(page, "/api/auth/me"))["body"]

    async def screenshot(self, page, name):
        await page.screenshot(path=str(self.output / f"{name}.png"), full_page=True)

    async def about(self, page):
        await page.get_by_role("button", name=re.compile(r"v0\.20\.0")).first.click()
        attribution = page.locator("[data-about-attribution]")
        await expect(attribution).to_contain_text("基于 infinite-canvas")
        assert await attribution.get_by_role("link").get_attribute("href") == "https://github.com/basketikun/infinite-canvas"
        await attribution.locator("summary").click()
        license_text = await attribution.locator("pre").inner_text()
        assert license_text.strip() == (ROOT / "LICENSE").read_text(encoding="utf-8").strip()
        await self.screenshot(page, "about-mit")
        await page.keyboard.press("Escape")
        self.check("关于入口保留上游链接、署名及完整MIT原文")

    async def mobile(self, page):
        await page.set_viewport_size({"width": 390, "height": 844})
        for path, name in [("/", "home"), ("/templates", "templates"), ("/billing", "billing")]:
            await page.goto(ORIGIN + path)
            await page.wait_for_load_state("networkidle")
            await page.wait_for_function("document.documentElement.scrollWidth<=innerWidth")
            widths = await page.evaluate("({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth})")
            assert widths["body"] <= widths["viewport"]
            await self.screenshot(page, "mobile-" + name)
            self.check("最终390px" + path + "可用且无页面横向滚动", **widths)
        await page.set_viewport_size({"width": 1600, "height": 1000})

    async def gateway_image(self, page, n=1, prompt="最终网关验收"):
        return await self.api(page, "/api/gateway/v1/images/generations", "POST", {"model": self.bridge.info["fixtureModels"]["image"], "prompt": prompt, "n": n, "size": "1024x1024"})

    async def workbench_generate(self, page, prompt, byok=False):
        await page.goto(ORIGIN + "/image")
        await page.wait_for_load_state("networkidle")
        if byok:
            await page.locator(".canvas-composer-model-picker").click()
            await page.get_by_role("option").filter(has_text="byok-image").click()
        await page.get_by_placeholder("描述画面主体、风格、构图、光线和用途", exact=True).fill(prompt)
        await page.get_by_role("button", name=re.compile(r"^(开始生成|生成 ·)"), exact=False).click()
        await expect(page.get_by_alt_text(re.compile(r"生成结果|生成图片|结果 1"))).to_have_count(1, timeout=15000)
        await self.screenshot(page, "image-" + ("byok" if byok else "platform"))

    async def configure_byok(self, page):
        await page.goto(ORIGIN + "/config")
        await page.get_by_role("button", name="新增渠道", exact=True).click()
        drawer = page.get_by_role("dialog", name="编辑渠道", exact=True)
        await drawer.get_by_label("渠道名称", exact=True).fill("受控自带Key")
        await drawer.get_by_label("接口地址", exact=True).fill(BYOK_ORIGIN)
        await drawer.get_by_label("API Key", exact=True).fill(self.byok_key)
        await drawer.get_by_role("button", name="选择模型", exact=True).click()
        select = page.get_by_role("dialog", name=re.compile("选择渠道模型"))
        await select.get_by_role("button", name="拉取模型列表", exact=True).click()
        await select.get_by_role("checkbox", name="byok-image", exact=True).check()
        await select.get_by_role("button", name=re.compile(r"确\s*定")).click()
        await drawer.get_by_role("button", name=re.compile(r"保\s*存")).click()
        await expect(drawer).not_to_be_visible()
        self.check("通过真实渠道设置界面配置并拉取受控BYOK模型")

    async def style_reference(self, page, workspace):
        brands = (await self.api(page, "/api/brands"))["body"]
        brand = next(item for item in brands if item["isDefault"])
        data = (self.output / "product.png").read_bytes()
        signed = (await self.api(page, "/api/uploads/presign", "POST", {"purpose": "brand_asset", "mimeType": "image/png", "bytes": len(data)}))["body"]
        status = await page.evaluate("""async ({signed,bytes}) => (await fetch(signed.uploadUrl,{method:'PUT',headers:signed.headers,credentials:'omit',body:Uint8Array.from(atob(bytes),c=>c.charCodeAt(0))})).status""", {"signed": signed, "bytes": base64.b64encode(data).decode()})
        assert status == 200
        asset = await self.api(page, f'/api/brands/{brand["id"]}/assets', "POST", {"kind": "style_ref", "objectKey": signed["objectKey"], "title": "不得发给BYOK的品牌参考.png", "attachOnGenerate": True})
        assert asset["status"] == 201

    async def normal(self, browser):
        context = await self.context(browser)
        page = await self.page(context)
        try:
            started = time.monotonic()
            session = await self.register(page)
            personal = session["currentWorkspaceId"]
            assert (await self.api(page, "/api/billing/summary"))["body"]["balance"] == 200
            await self.setup_brand(page)
            fixture = next(item for item in self.bridge.info["fixtureTemplates"] if item["sourceTemplateId"] == "tpl_ecom_main_set")
            await self.api(page, f'/api/templates/{fixture["id"]}/use', "POST", {})
            await page.goto(ORIGIN + "/")
            await expect(page.locator(".platform-home")).to_be_visible()
            await expect(page.locator(".home-brand")).to_contain_text("模板验收品牌")
            await expect(page.locator(".home-brand")).to_contain_text("验收品牌一致性")
            await expect(page.locator(".home-template")).to_have_count(4)
            await self.screenshot(page, "home-before")
            await page.locator(f'.home-template[data-template-id="{fixture["id"]}"]').click()
            await expect(page).to_have_url(re.compile(r"/templates\?id="))
            await expect(page.locator("aside.template-detail")).to_have_attribute("data-template-id", fixture["id"])
            self.check("新首页推荐来自真实模板、显示真实品牌，模板ID链接选中正确详情")
            _, _, run, _ = await self.insert(page, fixture, "home-ecom", open_library=False)
            await self.begin(page)
            project, _ = await self.finish(page, "home-ecom", run)
            elapsed = round(time.monotonic() - started, 2)
            assert elapsed < 180
            await expect(page.locator('a[title="查看点数与用量"]')).to_contain_text("160")
            self.check("新用户注册经首页到电商模板出8图小于3分钟，顶栏无需刷新更新200→160", elapsedSeconds=elapsed)
            jobs = (await self.api(page, "/api/billing/jobs"))["body"]["items"]
            transactions = (await self.api(page, "/api/billing/transactions"))["body"]["items"]
            assert len(jobs) == 8 and sum(item["chargedCredits"] for item in jobs) == 40
            for job in jobs:
                rows = [item for item in transactions if item.get("jobId") == job["id"]]
                assert {item["type"] for item in rows} == {"hold", "settle"}
                assert sum(item["amount"] for item in rows) == -job["chargedCredits"]
            await page.goto(ORIGIN + "/")
            await page.wait_for_load_state("networkidle")
            assert await page.locator(".home-job[data-job-id]").evaluate_all("rows=>rows.map(row=>row.dataset.jobId)") == [job["id"] for job in jobs[:4]]
            await expect(page.locator(f'.home-project[data-project-id="{project["id"]}"]')).to_be_visible()
            await self.screenshot(page, "home-after")
            await page.goto(ORIGIN + "/billing")
            await expect(page.get_by_role("heading", name="用量与计费", exact=True)).to_be_visible()
            await self.screenshot(page, "billing-jobs")
            self.check("首页最近4任务和本地项目来自真实数据，8个成功job与冻结/结算流水逐项对应")
            await self.mobile(page)
            await page.goto(ORIGIN + "/")
            await self.about(page)
            await page.goto(ORIGIN + f'/canvas/{project["id"]}')
            await self.bridge.rpc(operation="control", control={"providerUnavailable": True})
            await self.begin(page)
            await expect(page.locator("[data-template-run-bar]")).to_contain_text("失败待重试", timeout=15000)
            assert (await self.api(page, "/api/billing/summary"))["body"]["balance"] == 160
            failed = (await self.api(page, "/api/billing/jobs?status=failed"))["body"]["items"]
            assert len(failed) == 5 and all(item["chargedCredits"] == 0 for item in failed)
            ledger = (await self.api(page, "/api/billing/transactions"))["body"]["items"]
            assert all({item["type"] for item in ledger if item.get("jobId") == job["id"]} == {"hold", "refund"} for job in failed)
            await self.screenshot(page, "failed-provider-refund")
            await self.bridge.rpc(operation="control", control={"providerUnavailable": False})
            self.check("错误供应商base_url使节点报错，5个任务各全额退款且余额仍160")
            for n in [13, 13, 14]:
                assert (await self.gateway_image(page, n=n, prompt="受控余额耗尽验收"))["status"] == 200
            before = (await self.api(page, "/api/billing/jobs"))["body"]
            trace_count = len(await self.trace())
            await self.begin(page)
            modal = page.get_by_role("dialog", name="点数不足", exact=True)
            await expect(modal).to_be_visible()
            await expect(page.locator("[data-template-run-bar]")).to_contain_text("失败待重试")
            assert len(await self.trace()) == trace_count
            assert (await self.api(page, "/api/billing/jobs"))["body"] == before
            await self.screenshot(page, "insufficient-402")
            await modal.get_by_role("button", name="知道了", exact=True).click()
            self.check("余额0返回402并弹窗；不创建job、不调用供应商")
            await self.member_cap(browser, page)
            await page.evaluate("""async workspace=>fetch('/api/auth/me',{headers:{'X-IC-Workspace':workspace}})""", personal)
            await page.goto(ORIGIN + "/")
            await self.style_reference(page, personal)
            await self.configure_byok(page)
            before = (await self.api(page, "/api/billing/jobs"))["body"]
            summary = (await self.api(page, "/api/billing/summary"))["body"]
            trace_count = len(await self.trace())
            await self.workbench_generate(page, "BYOK真实界面生成验收", byok=True)
            assert len(self.byok_requests) == 1
            call = self.byok_requests[0]
            assert "验收品牌一致性" in call["prompt"] and "BYOK真实界面生成验收" in call["prompt"]
            assert not set(call["keys"]).intersection({"image", "images", "reference_images"})
            assert not call["platformHeaders"] and not call["cookieSent"] and call["keyMatched"]
            assert (await self.api(page, "/api/billing/jobs"))["body"] == before
            assert (await self.api(page, "/api/billing/summary"))["body"] == summary
            assert len(await self.trace()) == trace_count
            self.check("BYOK从真实配置到生成成功；只带品牌文字，不发品牌参考、平台Cookie/上下文，不产生平台job或扣费")
        except Exception:
            await self.screenshot(page, "failure")
            (self.output / "failure.html").write_text(await page.content(), encoding="utf-8")
            raise
        finally:
            await context.close()

    async def member_cap(self, browser, owner):
        team = (await self.api(owner, "/api/workspaces", "POST", {"name": "最终额度验收团队"}))["body"]
        grant = await self.api(owner, f'/api/admin/workspaces/{team["id"]}/grant', "POST", {"credits": 20, "kind": "gift", "note": "独占验收团队"})
        assert grant["status"] == 200
        invite = (await self.api(owner, f'/api/workspaces/{team["id"]}/invites', "POST", {"role": "member"}))["body"]
        context = await self.context(browser)
        member = await self.page(context)
        try:
            await member.goto(ORIGIN + "/")
            registered = await self.api(member, "/api/auth/register", "POST", {"name": "额度成员", "email": f"cap-{secrets.token_hex(6)}@example.test", "password": secrets.token_urlsafe(24), "inviteToken": invite["token"]})
            assert registered["status"] == 201
            user_id = registered["body"]["user"]["id"]
            updated = await self.api(owner, f'/api/workspaces/{team["id"]}/members/{user_id}', "PATCH", {"monthlyCap": 4})
            assert updated["status"] == 200
            assert (await self.gateway_image(member))["status"] == 200
            count = len(await self.trace())
            denied = await self.gateway_image(member)
            assert denied["status"] == 402 and denied["body"]["error"]["code"] == "member_cap_exceeded"
            assert len(await self.trace()) == count
            assert (await self.api(owner, f'/api/workspaces/{team["id"]}/members/{user_id}', "PATCH", {"role": "admin"}))["status"] == 200
            assert (await self.gateway_image(member))["status"] == 200
            stats = (await self.api(member, "/api/billing/summary"))["body"]
            assert stats["balance"] == 12 and stats["monthJobs"]["image"] == 2
            self.check("member额度4点：首次成功、再次402不上游；相同成员改admin后超出上限仍成功", chargedCredits=8, balance=12)
        finally:
            await context.close()

    async def billing_off(self, browser):
        context = await self.context(browser)
        page = await self.page(context)
        try:
            await self.register(page)
            initial = (await self.api(page, "/api/billing/summary"))["body"]
            assert initial["billingEnabled"] is False and initial["balance"] == 200
            await self.workbench_generate(page, "关闭平台计费真实生成")
            summary = (await self.api(page, "/api/billing/summary"))["body"]
            jobs = (await self.api(page, "/api/billing/jobs"))["body"]["items"]
            ledger = (await self.api(page, "/api/billing/transactions"))["body"]["items"]
            assert summary["balance"] == 200 and summary["monthCharged"] == 0
            assert summary["monthJobs"]["image"] == 1 and summary["successRate"] == 100
            assert len(jobs) == 1 and jobs[0]["chargedCredits"] == 0 and jobs[0]["status"] == "succeeded"
            assert all(item["type"] == "grant" for item in ledger)
            await page.goto(ORIGIN + "/billing")
            await expect(page.get_by_role("heading", name="用量统计", exact=True)).to_be_visible()
            await self.screenshot(page, "billing-disabled")
            await page.goto(ORIGIN + "/templates")
            fixture = self.bridge.info["fixtureTemplates"][0]
            await page.locator(f'.template-card[data-template-id="{fixture["id"]}"]').click()
            await expect(page.locator("aside.template-detail")).to_contain_text("平台免计费")
            await expect(page.locator("aside.template-detail")).not_to_contain_text("自带 Key")
            self.check("BILLING_ENABLED=false：真实UI生成成功、余额200不变、job与用量完整记录、无冻结/结算流水且显示用量统计")
        except Exception:
            await self.screenshot(page, "failure")
            (self.output / "failure.html").write_text(await page.content(), encoding="utf-8")
            raise
        finally:
            await context.close()

    async def web_only(self, browser):
        context = await self.context(browser)
        page = await self.page(context)
        try:
            await page.goto(ORIGIN + "/")
            await page.wait_for_load_state("networkidle")
            await expect(page.get_by_role("button", name="打开画布", exact=True)).to_be_visible()
            await expect(page.locator(".platform-shell")).to_have_count(0)
            await page.get_by_role("button", name="打开画布", exact=True).click()
            await expect(page).to_have_url(ORIGIN + "/canvas")
            await page.get_by_role("button", name="新建画布", exact=True).first.click()
            await expect(page).to_have_url(re.compile(r"/canvas/[^/]+$"))
            await page.get_by_role("button", name="文本", exact=True).click()
            await expect(page.locator("[data-node-id]")).to_have_count(1)
            project, _ = await self.export(page, "web-only-canvas")
            assert len(project["nodes"]) == 1 and project["nodes"][0]["type"] == "text"
            await self.screenshot(page, "web-only-canvas")
            await self.configure_byok(page)
            await self.workbench_generate(page, "纯前端原生生图验收", byok=True)
            assert not self.api_requests, self.api_requests
            assert not await self.trace()
            assert len(self.byok_requests) == 1 and not self.byok_requests[0]["platformHeaders"]
            await self.about(page)
            self.check("PLATFORM_API_BASE空：无登录与平台API；原画布新建/文本/ZIP导出及自带渠道生图可用")
        except Exception:
            await self.screenshot(page, "failure")
            (self.output / "failure.html").write_text(await page.content(), encoding="utf-8")
            raise
        finally:
            await context.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["normal", "billing-off", "web-only"], default="normal")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = (args.output or ROOT / "artifacts/acceptance" / ("browser-m5-" + args.mode)).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"stage": "m5", "mode": args.mode, "passed": False, "realProviderCalls": False, "httpListenerStarted": False, "deploymentAcceptance": False, "fileRedirectsFollowedByTransport": True, "multipartFileBytesPreservedByTransport": True, "byokRespondedByBrowserRoute": True}
    report["buildAssets"] = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', (ROOT / "web/dist/index.html").read_text(encoding="utf-8"))
    bridge = acceptance = None
    started = time.monotonic()
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe", headless=True)
            try:
                email = f"m5-admin-{secrets.token_hex(6)}@example.test"
                images = prepare_images(output)
                video = await prepare_video(browser, output)
                bridge = await AsyncBridge.start(ROOT / ".tools/node_modules/@oven/bun-windows-x64/bin/bun.exe", output, images, video, prepare_audio(output), {"BROWSER_TEST_BILLING": "false" if args.mode == "billing-off" else "true", "BROWSER_TEST_SIGNUP_BONUS": "200", "BROWSER_TEST_ADMIN_EMAIL": email})
                acceptance = FinalAcceptance(bridge, output, args.mode, email)
                if args.mode == "normal":
                    await acceptance.normal(browser)
                elif args.mode == "billing-off":
                    await acceptance.billing_off(browser)
                else:
                    await acceptance.web_only(browser)
                assert not acceptance.page_errors, acceptance.page_errors
                assert not acceptance.transport_errors, acceptance.transport_errors
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
            report.update(checks=acceptance.checks, apiRequests=acceptance.api_requests, storageRequests=acceptance.storage_requests, pageErrors=acceptance.page_errors, consoleErrors=acceptance.console_errors, transportErrors=acceptance.transport_errors, cancellations=acceptance.cancellations, byokRequests=acceptance.byok_requests, blockedExternal=sorted(acceptance.blocked_external))
        if bridge:
            try:
                report["providerTrace"] = await acceptance.trace()
                report["cleanup"] = await bridge.close()
            except Exception as error:
                report["passed"] = False
                report["cleanupError"] = str(error)
        report["elapsedSeconds"] = round(time.monotonic() - started, 2)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "mode": args.mode, "checks": len(report.get("checks", [])), "report": str(output / "report.json"), "error": report.get("error"), "cleanupError": report.get("cleanupError")}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
