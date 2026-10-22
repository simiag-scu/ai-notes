"""Run after build and ui-server. Uses an isolated Edge profile and offline AI-site fixtures."""
import json
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / ".artifacts"
EXT = ART / "test-extension"
shutil.rmtree(EXT, ignore_errors=True)
shutil.copytree(ROOT / "dist/extension", EXT)
background = EXT / "background.js"
background.write_text(background.read_text().replace("127.0.0.1:17861", "127.0.0.1:17862"))
manifest = EXT / "manifest.json"
manifest.write_text(manifest.read_text().replace("127.0.0.1:17861", "127.0.0.1:17862"))
token = json.loads((ROOT / ".test-vault/ai-study-notes/.data/connection.json").read_text())["bridgeToken"]

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(str(ART / "extension-profile"), headless=True,
        executable_path="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        viewport={"width": 430, "height": 1000})
    worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker", timeout=15000)
    extension_id = worker.url.split("/")[2]
    worker.evaluate("async (token) => chrome.storage.local.set({bridgeToken:token, apiBase:'http://127.0.0.1:17862'})", token)
    panel = context.new_page()
    errors = []
    panel.on("pageerror", lambda error: errors.append(str(error)))
    panel.goto(f"chrome-extension://{extension_id}/panel/index.html")
    expect(panel.locator("#connection-label")).to_have_text("本地文件模式")
    # Edge's headless extension pages do not consistently expose a painted surface
    # on macOS. Chrome UI checks cover real clicks; these exercise the real extension
    # runtime, service worker, content scripts and DOM event handlers.
    panel.locator("#new-note").evaluate("el => el.click()")
    panel.locator("#new-title").evaluate("el => el.value='扩展集成测试'")
    panel.locator("#new-form").evaluate("el => el.requestSubmit()")
    expect(panel.locator("#note-title")).to_have_text("扩展集成测试")

    ai = context.new_page()
    ai.route("https://chatgpt.com/**", lambda route: route.fulfill(content_type="text/html", body='''<!doctype html><meta charset="UTF-8"><title>隔离测试页面</title><main><div data-message-author-role="user" data-message-id="q1"><p>如何记录条件？</p></div><div data-message-author-role="assistant" data-message-id="a1"><div class="markdown"><h2>理解条件</h2><p>保留条件与<strong>例外</strong>，避免断章取义。</p><ul><li>核对定义</li><li>记录来源</li></ul></div></div></main>'''))
    ai.goto("https://chatgpt.com/c/shiye-offline-fixture")
    ai.wait_for_selector("#shiye-capture-root", state="attached")
    result = worker.evaluate("async () => { const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'}); return chrome.tabs.sendMessage(tabs[0].id,{kind:'capture-page'}); }")
    assert result.get("count") == 2, result
    panel.locator("#sources-tab").evaluate("el => el.click()")
    expect(panel.locator("#source-cards")).to_contain_text("保留条件与**例外**")
    again = worker.evaluate("async () => { const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'}); return chrome.tabs.sendMessage(tabs[0].id,{kind:'capture-page'}); }")
    assert again.get("count") == 0, again

    # Switching target notes must reset the content-script cache.
    panel.locator("#new-note").evaluate("el => el.click()")
    panel.locator("#new-title").evaluate("el => el.value='扩展目标切换测试'")
    panel.locator("#new-form").evaluate("el => el.requestSubmit()")
    expect(panel.locator("#note-title")).to_have_text("扩展目标切换测试")
    switched = worker.evaluate("async () => { const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'}); return chrome.tabs.sendMessage(tabs[0].id,{kind:'capture-page'}); }")
    assert switched.get("count") == 2, switched
    # Browser Selection API + shortcut pipeline, without relying on shadow DOM internals.
    ai.locator(".markdown p").evaluate("el => {const range=document.createRange();range.selectNodeContents(el);window.getSelection().removeAllRanges();window.getSelection().addRange(range)}")
    ai.locator(".markdown p").dispatch_event("mouseup")
    worker.evaluate("async () => { const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'}); return chrome.tabs.sendMessage(tabs[0].id,{kind:'capture-selection'}); }")
    panel.locator("#preview-tab").evaluate("el => el.click()")
    expect(panel.locator("#preview")).to_contain_text("保留条件与例外")
    deepseek = context.new_page()
    deepseek.route("https://chat.deepseek.com/**", lambda route: route.fulfill(content_type="text/html", body='''<!doctype html><meta charset="UTF-8"><main><div data-role="user"><p>如何学习教材？</p></div><div data-role="assistant"><div class="ds-markdown"><p>先理解定义，再联系具体例子。</p></div></div></main>'''))
    deepseek.goto("https://chat.deepseek.com/a/chat/shiye-offline-fixture")
    deepseek.wait_for_selector("#shiye-capture-root", state="attached")
    deep_result = worker.evaluate("async () => { const tabs=await chrome.tabs.query({url:'https://chat.deepseek.com/*'}); return chrome.tabs.sendMessage(tabs[0].id,{kind:'capture-page'}); }")
    assert deep_result.get("count") == 2, deep_result
    assert not errors, errors
    print(json.dumps({"result":"passed", "checks":["real-extension-load", "extension-local-auth", "offline-chatgpt-adapter", "offline-deepseek-adapter", "deduplication", "target-switch", "selection-capture"], "accountTested":False}, ensure_ascii=False))
    context.close()
shutil.rmtree(ART / "extension-profile", ignore_errors=True)
