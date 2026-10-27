"""Short final-build visibility and English UI acceptance; no provider requests."""
import asyncio
import json
import re
import secrets
import time
import traceback

from playwright.async_api import async_playwright, expect
from final_browser_acceptance import FinalAcceptance
from templates_browser_acceptance import AsyncBridge, ROOT, ORIGIN


async def main():
    output = ROOT / "artifacts/acceptance/browser-m5-home-final"
    output.mkdir(parents=True, exist_ok=True)
    source = ROOT / "artifacts/acceptance/browser-m5-normal"
    bridge = acceptance = None
    started = time.monotonic()
    report = {"passed": False, "realProviderCalls": False, "httpListenerStarted": False, "buildAssets": re.findall(r'(?:src|href)="(/assets/[^\"]+)"', (ROOT / "web/dist/index.html").read_text(encoding="utf-8"))}
    try:
        bridge = await AsyncBridge.start(ROOT / ".tools/node_modules/@oven/bun-windows-x64/bin/bun.exe", output, source / "controlled-images.json", source / "controlled.webm", source / "controlled.wav", {"BROWSER_TEST_BILLING": "false"})
        acceptance = FinalAcceptance(bridge, output, "billing-off", f"home-final-{secrets.token_hex(6)}@example.test")
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe", headless=True)
            try:
                context = await acceptance.context(browser)
                page = await acceptance.page(context)
                await acceptance.register(page)
                await expect(page.locator(".platform-home")).to_be_visible()
                count = lambda: sum(item["path"] == "/api/billing/jobs" and item["method"] == "GET" for item in acceptance.api_requests)
                initial = count()
                await asyncio.sleep(5.5)
                visible = count()
                assert visible > initial
                # Headless Chrome does not reliably hide background tabs. Drive the actual
                # visibilitychange subscriber with explicit document state, leaving timers active.
                await page.evaluate("""() => {Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));}""")
                await asyncio.sleep(0.3)
                hidden_start = count()
                await asyncio.sleep(5.5)
                hidden_end = count()
                assert hidden_end == hidden_start
                await page.evaluate("""() => {Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));}""")
                await asyncio.sleep(5.5)
                resumed = count()
                assert resumed > hidden_end
                acceptance.check("首页可见5秒轮询、visibilitychange隐藏暂停、恢复可见后继续", visibleCalls=visible-initial, hiddenCalls=hidden_end-hidden_start, resumedCalls=resumed-hidden_end, visibilityMode="synthetic-document-state-and-native-listener")
                await page.get_by_role("button", name=re.compile(r"切换到.*English")).click()
                await expect(page.get_by_role("heading", name="Start with an industry workflow", exact=True)).to_be_visible()
                for text in ["Recommended templates", "Recent canvases", "Recent generations"]:
                    await expect(page.get_by_role("heading", name=text, exact=True)).to_be_visible()
                assert not re.search(r"\b(?:platform|topNav|template)\.[A-Za-z_]", await page.locator("body").inner_text())
                await acceptance.screenshot(page, "home-english")
                acceptance.check("真实语言切换按钮将新首页关键标题切换English，无原始翻译key")
                fixture = next(item for item in bridge.info["fixtureTemplates"] if item["sourceTemplateId"] == "tpl_ecom_main_set")
                await page.goto(ORIGIN + "/templates?id=" + fixture["id"])
                await expect(page.get_by_role("heading", name="Template center", exact=True)).to_be_visible()
                detail = page.locator("aside.template-detail")
                await expect(detail).to_contain_text("Platform billing disabled · No platform credits charged")
                await expect(detail).not_to_contain_text("BYOK")
                assert not re.search(r"\b(?:platform|topNav|template)\.[A-Za-z_]", await page.locator("body").inner_text())
                await acceptance.screenshot(page, "templates-free-english")
                acceptance.check("英文模板免计费明确平台不扣点，未混用BYOK或显示原始翻译key")
                assert not acceptance.page_errors and not acceptance.transport_errors
                assert not await acceptance.trace()
                report["passed"] = True
            finally:
                acceptance.closing = True
                await browser.close()
    except Exception as error:
        report.update(error=f"{type(error).__name__}: {error}", traceback=traceback.format_exc())
    finally:
        if acceptance:
            report.update(checks=acceptance.checks, apiRequests=acceptance.api_requests, pageErrors=acceptance.page_errors, transportErrors=acceptance.transport_errors)
        if bridge:
            report["providerTrace"] = await acceptance.trace()
            report["cleanup"] = await bridge.close()
        report["elapsedSeconds"] = round(time.monotonic()-started, 2)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "checks": len(report.get("checks", [])), "error": report.get("error")}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
