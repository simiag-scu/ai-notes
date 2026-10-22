"""Offline browser regression: cross-site OAuth callback -> 303 -> local dashboard.
Run tests/ui-server.mjs first. No real OpenAI login or inference is performed.
"""
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / ".artifacts"
ART.mkdir(exist_ok=True)
URL = "http://127.0.0.1:17862"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    page = browser.new_page(viewport={"width": 1200, "height": 1000})
    requests = []
    def record(request):
        if request.url.startswith(URL) and request.is_navigation_request():
            requests.append({"path": urlparse(request.url).path, "site": request.header_value("sec-fetch-site"), "mode": request.header_value("sec-fetch-mode"), "destination": request.header_value("sec-fetch-dest")})
    page.on("request", record)
    page.route("https://auth.openai.com/shiye-offline-return", lambda route: route.fulfill(content_type="text/html", body=f'<!doctype html><meta charset="UTF-8"><a href="{URL}/auth/callback?error=access_denied&amp;state=expired-test" id="return">返回工作台</a>'))
    page.goto("https://auth.openai.com/shiye-offline-return")
    page.locator("#return").click()
    expect(page.locator("#settings-dialog")).to_be_visible()
    expect(page.locator("#auth-notice")).to_be_visible()
    expect(page.locator("#auth-notice")).to_contain_text("登录请求已过期")
    expect(page.locator("#connection-label")).to_have_text("本地文件模式")
    assert "请直接打开本地工作台地址" not in page.locator("body").inner_text()
    assert any(row["site"] == "cross-site" and row["path"] == "/" and row["destination"] == "document" for row in requests), requests
    page.screenshot(path=str(ART / "06-auth-recovery.png"), full_page=True)
    page.reload()
    page.locator("#settings-button").click()
    expect(page.locator("#auth-notice")).to_contain_text("登录请求已过期")
    print(json.dumps({"result": "passed", "checks": ["cross-site-callback", "303-dashboard-return", "readable-error", "error-survives-reload"], "navigation": requests}, ensure_ascii=False))
    browser.close()
