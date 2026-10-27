"""One explicitly authorized paid e-commerce run. Preparation sends no provider request."""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import secrets
import shutil
import time
import traceback

from PIL import Image
from playwright.async_api import async_playwright, expect
from final_browser_acceptance import FinalAcceptance
from templates_browser_acceptance import AsyncBridge, ROOT, ORIGIN


class RealAcceptance(FinalAcceptance):
    async def run_real(self, browser):
        self.finish_timeout = 600000
        context = await self.context(browser)
        page = await self.page(context)
        result = {}
        try:
            started = time.monotonic()
            await self.register(page)
            fixture = self.bridge.info["fixtureTemplates"][0]
            assert fixture["sourceTemplateId"] == "tpl_ecom_main_set" and fixture["onlyModelIdsSubstituted"]
            await self.api(page, f'/api/templates/{fixture["id"]}/use', "POST", {})
            await page.goto(ORIGIN + "/")
            await expect(page.locator(".platform-home")).to_be_visible()
            await page.locator(f'.home-template[data-template-id="{fixture["id"]}"]').click()
            await expect(page.locator("aside.template-detail")).to_have_attribute("data-template-id", fixture["id"])
            _, _, run, before = await self.insert(page, fixture, "real-ecom", open_library=False, variable_values={"sellingPoints": "白色陶瓷杯，无商标，保持参考图片中的杯体外观，不添加未提供的材质参数或功效。", "scene": "木质桌面 · 清晨侧光"})
            generation_started = time.monotonic()
            await self.begin(page)
            project, files = await self.finish(page, "real-ecom", run)
            result.update(registrationToImagesSeconds=round(time.monotonic() - started, 2), generationSeconds=round(time.monotonic() - generation_started, 2))
            result["withinThreeMinutes"] = result["registrationToImagesSeconds"] < 180
            traces = await self.trace()
            assert len(traces) == 8 and all(row["model"] == "gpt-image-2" and row["n"] == 1 and row["status"] == "succeeded" for row in traces)
            original_hash = hashlib.sha256((self.output / "product.png").read_bytes()).hexdigest()
            scene = next(node for node in project["nodes"] if node["id"] == run["idMap"]["scene"])
            primary_hash = hashlib.sha256(files[scene["metadata"]["storageKey"]]).hexdigest()
            scenes = [row for row in traces if row.get("nodeId") == run["idMap"]["scene"]]
            adaptations = [row for row in traces if row.get("nodeId") in [run["idMap"][key] for key in ["size_tb", "size_dy", "size_xhs"]]]
            assert len(scenes) == 5 and all(row["inputHashes"] == [original_hash] for row in scenes)
            assert primary_hash != original_hash and primary_hash in [value for row in scenes for value in row["outputHashes"]]
            assert len(adaptations) == 3 and all(row["inputHashes"] == [primary_hash] for row in adaptations)
            assert sum(len(row["outputHashes"]) for row in traces) == 8
            self.check("真实供应商8次gpt-image-2完成；5主图读取商品，3适配图读取已生成主图SHA256")
            after = (await self.api(page, "/api/billing/summary"))["body"]["balance"]
            await expect(page.locator('a[title="查看点数与用量"]')).to_contain_text(str(after))
            assert before == 200 and after == 160
            jobs = []
            for _ in range(100):
                jobs = (await self.api(page, "/api/billing/jobs"))["body"]["items"]
                if len(jobs) == 8 and all(len(job["outputs"]) == 1 for job in jobs):
                    break
                await asyncio.sleep(0.2)
            assert len(jobs) == 8 and all(job["status"] == "succeeded" and len(job["outputs"]) == 1 for job in jobs)
            assert sum(job["chargedCredits"] for job in jobs) == 40
            ledger = (await self.api(page, "/api/billing/transactions"))["body"]["items"]
            for job in jobs:
                rows = [row for row in ledger if row.get("jobId") == job["id"]]
                assert {row["type"] for row in rows} == {"hold", "settle"}
                assert sum(row["amount"] for row in rows) == -job["chargedCredits"]
            archived = []
            for index, job in enumerate(jobs):
                output = job["outputs"][0]
                data = await page.evaluate("""async path=>{const response=await fetch(path);const bytes=new Uint8Array(await response.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=16384)binary+=String.fromCharCode(...bytes.subarray(offset,offset+16384));return {status:response.status,base64:btoa(binary)};}""", output["url"])
                assert data["status"] == 200
                raw = base64.b64decode(data["base64"])
                digest = hashlib.sha256(raw).hexdigest()
                assert digest in [value for row in traces for value in row["outputHashes"]]
                with Image.open(io.BytesIO(raw)) as picture:
                    width, height = picture.size
                    picture.verify()
                (self.output / f"real-output-{index + 1}.png").write_bytes(raw)
                archived.append({"jobId": job["id"], "sha256": digest, "width": width, "height": height, "bytes": len(raw), "chargedCredits": job["chargedCredits"]})
            result.update(balanceBefore=before, balanceAfter=after, chargedCredits=40, jobs=jobs, archivedOutputs=archived, sourceImageHash=original_hash, primaryImageHash=primary_hash)
            result["sizeDifferences"] = [{"sequence": row["sequence"], "requested": row.get("size"), "actual": size} for row in traces for size in row["outputSizes"] if row.get("size") != f'{size["width"]}x{size["height"]}']
            self.check("真实8图账本40点、顶栏200→160、8个S3归档均可读取解码且SHA256等于实际供应商输出")
            self.check("记录实际输出尺寸与I017尺寸偏差，未重采样输出", sizeDifferences=result["sizeDifferences"], registrationToImagesSeconds=result["registrationToImagesSeconds"])
            await page.goto(ORIGIN + "/")
            await self.screenshot(page, "real-home-after")
            await page.goto(ORIGIN + "/billing")
            await self.screenshot(page, "real-billing")
            return result
        except Exception:
            await self.screenshot(page, "failure")
            raise
        finally:
            await context.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare-only", action="store_true")
    mode.add_argument("--execute-paid-once", action="store_true")
    mode.add_argument("--resume-zero-call-failure-once", action="store_true")
    args = parser.parse_args()
    base_output = ROOT / "artifacts/acceptance/browser-m5-real-ecom"
    recovery_evidence = None
    if args.resume_zero_call_failure_once:
        previous_path = base_output / "report.json"
        previous_bytes = previous_path.read_bytes()
        previous = json.loads(previous_bytes)
        if not (base_output / "paid-run.started.json").is_file() or previous.get("passed") is not False or previous.get("preparedOnly") is not False or previous.get("providerTrace") != [] or previous.get("cleanup", {}).get("ok") is not True or previous.get("cleanup", {}).get("storageCleaned") is not True:
            raise RuntimeError("仅原始执行零供应商调用且清理成功的失败可恢复；原记录保持不变")
        recovery_evidence = {"previousReport": str(previous_path), "sha256": hashlib.sha256(previous_bytes).hexdigest(), "previousProviderCalls": 0}
    output = base_output / "zero-call-retry" if args.resume_zero_call_failure_once else base_output
    output.mkdir(parents=True, exist_ok=True)
    source = ROOT / "artifacts/acceptance/real-provider-image.png"
    assert source.is_file() and (ROOT / ".tools/provider-secret.enc").is_file()
    if args.execute_paid_once or args.resume_zero_call_failure_once:
        # An accidental second invocation stops before loading credentials or starting the bridge.
        marker_path = base_output / ("paid-run.zero-call-retry.started.json" if args.resume_zero_call_failure_once else "paid-run.started.json")
        with marker_path.open("x", encoding="utf-8") as marker:
            json.dump({"startedAtUnix": time.time(), "maximumProviderCalls": 8, "model": "gpt-image-2", "recoveryEvidence": recovery_evidence}, marker)
    shutil.copyfile(source, output / "product.png")
    report = {"passed": False, "preparedOnly": args.prepare_only, "realProvider": True, "httpListenerStarted": False, "deploymentAcceptance": False, "multipartFileBytesPreservedByTransport": True, "fileRedirectsFollowedByTransport": True, "sourceImage": str(source), "buildAssets": re.findall(r'(?:src|href)="(/assets/[^\"]+)"', (ROOT / "web/dist/index.html").read_text(encoding="utf-8"))}
    if recovery_evidence:
        report["recoveryEvidence"] = recovery_evidence
    bridge = acceptance = None
    started = time.monotonic()
    try:
        bridge = await AsyncBridge.start(ROOT / ".tools/node_modules/@oven/bun-windows-x64/bin/bun.exe", output, output / "unused-images.json", output / "unused.webm", output / "unused.wav", {"BROWSER_REAL_ECOM": "execute-paid-once", "BROWSER_TEST_SIGNUP_BONUS": "200"}, ["--real-ecom"], 660)
        assert bridge.info["realProvider"] and not bridge.info["controlledProvider"]
        if args.prepare_only:
            assert not (await bridge.rpc(operation="trace"))["traces"]
            report.update(passed=True, providerCalls=0, keyDecryptedInMemory=True)
        else:
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe", headless=True)
                acceptance = RealAcceptance(bridge, output, "normal", f"real-ecom-{secrets.token_hex(6)}@example.test")
                try:
                    report.update(await acceptance.run_real(browser))
                    assert not acceptance.page_errors and not acceptance.transport_errors
                    report["functionalPassed"] = True
                    report["passed"] = report["withinThreeMinutes"]
                finally:
                    acceptance.closing = True
                    await browser.close()
    except Exception as error:
        report.update(error=f"{type(error).__name__}: {error}", traceback=traceback.format_exc())
    finally:
        if acceptance:
            if acceptance.background:
                await asyncio.gather(*acceptance.background, return_exceptions=True)
            report.update(checks=acceptance.checks, apiRequests=acceptance.api_requests, storageRequests=acceptance.storage_requests, pageErrors=acceptance.page_errors, transportErrors=acceptance.transport_errors)
        if bridge:
            try:
                report["providerTrace"] = (await bridge.rpc(operation="trace"))["traces"]
                report["cleanup"] = await bridge.close()
            except Exception as error:
                report.update(passed=False, cleanupError=type(error).__name__)
        report["elapsedSeconds"] = round(time.monotonic() - started, 2)
        path = output / ("preparation.json" if args.prepare_only else "report.json")
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "preparedOnly": args.prepare_only, "providerCalls": len(report.get("providerTrace", [])), "error": report.get("error"), "report": str(path)}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
