"""Isolated UI verification. Requires Python Playwright and installed Chrome.
Start tests/ui-server.mjs first; no real AI calls are made.
"""
import base64
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeout

PROJECT = Path(__file__).resolve().parent.parent
ARTIFACTS = PROJECT / ".artifacts"
ARTIFACTS.mkdir(exist_ok=True)
URL = "http://127.0.0.1:17862"
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, permissions=["clipboard-read", "clipboard-write"])
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.goto(URL)
    # The production SSE event stream deliberately keeps one request open.
    # After trying networkidle, the rendered connection state is the readiness signal.
    try:
        page.wait_for_load_state("networkidle", timeout=1500)
    except PlaywrightTimeout:
        pass
    expect(page.locator("#connection-label")).to_have_text("本地文件模式")
    page.screenshot(path=str(ARTIFACTS / "01-welcome.png"), full_page=True)
    buttons = page.get_by_role("button").all_text_contents()
    assert any("新建学习笔记" in text for text in buttons)

    page.locator("#welcome-new").click()
    page.get_by_label("笔记名称").fill("界面测试 · 学习方法")
    page.get_by_role("button", name="建立笔记", exact=True).click()
    expect(page.locator("#note-title")).to_have_text("界面测试 · 学习方法")
    page.locator("#import-button").click()
    page.locator("#import-text").fill("## 保留自己的理解\n\n先理解，再联结 [[已有知识]]，最后回顾。\n\n- 记录条件\n- 核对例外")
    page.locator("#import-url").fill("https://chatgpt.com/c/isolated-ui-test")
    page.get_by_role("button", name="加入当前笔记").click()
    expect(page.locator("#preview")).to_contain_text("保留自己的理解")
    expect(page.locator("#usage-number")).to_have_text("0")

    page.locator("#source-tab").click()
    original = page.locator("#editor").input_value()
    page.locator("#editor").fill(original + "\n手动补充：学习时先问清适用范围。\n")
    page.locator("#save-note").click()
    expect(page.locator("#save-state")).to_contain_text("已保存在本机")
    page.locator("#preview-tab").click()
    expect(page.locator("#preview")).to_contain_text("手动补充")

    image = ARTIFACTS / "fixture.png"
    image.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1cAAAAASUVORK5CYII="))
    page.locator("#import-button").click()
    page.locator("#import-image").set_input_files(str(image))
    page.get_by_role("button", name="加入当前笔记").click()
    expect(page.locator("#preview img")).to_be_visible()
    page.wait_for_function("document.querySelector('#preview img')?.naturalWidth > 0")

    page.locator("#import-button").click()
    page.locator("#import-text").fill("待整理的测试回答：学习过程包括理解、联结、回顾；每一步都应保留适用条件。")
    page.locator("#import-direct").uncheck()
    page.get_by_role("button", name="加入当前笔记").click()
    page.locator("#summarize").click()
    expect(page.locator(".draft-card")).to_have_count(1)
    page.screenshot(path=str(ARTIFACTS / "02-drafts.png"), full_page=True)
    page.locator("#select-all").check()
    page.locator("#accept-selected").click()
    expect(page.locator("#preview")).to_contain_text("这是隔离测试模型生成的草稿")
    expect(page.locator(".draft-card")).to_have_count(0)

    page.locator("#convert-note").click()
    page.get_by_role("button", name="生成另一种版本").click()
    expect(page.locator("#note-kind")).to_contain_text("大纲模式")
    page.locator("#copy-note").click()
    clipboard = page.evaluate("navigator.clipboard.readText()")
    assert all(not line.strip() or line.lstrip().startswith("- ") for line in clipboard.splitlines())
    assert "[[已有知识]]" in clipboard
    page.screenshot(path=str(ARTIFACTS / "03-outline.png"), full_page=True)

    # Configure a synthetic provider. The isolated service never calls DeepSeek.
    page.locator("#chat-model").click()
    page.locator("#provider").select_option("deepseek")
    page.locator("#model").fill("synthetic-test")
    page.locator("#api-key").fill("isolated-not-a-real-key")
    page.locator("#settings-form button[type=submit]").click()
    expect(page.locator("#chat-model")).to_contain_text("synthetic-test")
    page.locator("#settings-dialog [data-close]").click()

    page.locator("#chat-input").fill("请用简单的话说明概念与联系")
    page.locator("#send-chat").click()
    expect(page.locator("#stop-chat")).to_be_visible()
    expect(page.locator(".streaming-text")).to_be_visible()
    expect(page.locator(".chat-message.assistant .message-body")).to_contain_text("隔离模型的流式回答")
    expect(page.locator("#stop-chat")).to_be_hidden()
    expect(page.locator(".chat-message")).to_have_count(2)
    assert "隔离模型" not in page.locator("#editor").input_value(), "Chat must not write answers into formal notes automatically"

    # Select only a sentence from the rendered assistant answer.
    page.evaluate("""() => {
      const body = document.querySelector('.chat-message.assistant .message-body');
      const paragraph = [...body.querySelectorAll('p')].find(x => x.textContent.includes('先理解概念'));
      const node = paragraph.firstChild, start = node.textContent.indexOf('先理解概念');
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + '先理解概念，再核对适用条件。'.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      body.dispatchEvent(new PointerEvent('pointerup', {bubbles:true}));
    }""")
    page.locator("#clip-chat-selection").click()
    expect(page.locator("#preview")).to_contain_text("先理解概念，再核对适用条件")
    page.locator("#auto-summary").check(force=True)
    page.locator("#source-tab").click()
    original = page.locator("#editor").input_value()
    page.locator("#editor").fill(original + "  - 聊天时手动编辑，保持这行。\n")
    page.locator("#chat-input").fill("继续解释适用条件")
    page.locator("#chat-input").press("Enter")
    expect(page.locator(".chat-message")).to_have_count(4)
    expect(page.locator("#stop-chat")).to_be_hidden()
    expect(page.locator("#draft-count")).to_have_text("1", timeout=10000)
    assert "聊天时手动编辑，保持这行。" in page.locator("#editor").input_value()
    page.locator("#save-note").click()
    page.locator("#preview-tab").click()
    expect(page.locator("#pending-badge")).to_have_text("1")
    page.locator("#jump-drafts").click()
    expect(page.locator("#accept-selected")).to_be_in_viewport()
    page.wait_for_function("() => {const p=document.querySelector('.notes-pane'); return p.scrollTop >= p.scrollHeight - p.clientHeight - 2}")
    page.screenshot(path=str(ARTIFACTS / "09-chat-with-drafts.png"), full_page=True)
    page.locator("#select-all").check()
    page.locator("#accept-selected").click()
    expect(page.locator("#draft-count")).to_have_text("0")
    page.screenshot(path=str(ARTIFACTS / "08-integrated-chat.png"), full_page=True)

    page.reload()
    expect(page.locator(".chat-message")).to_have_count(4)
    page.locator("#chat-input").fill("测试停止生成")
    page.locator("#send-chat").click()
    expect(page.locator("#stop-chat")).to_be_visible()
    page.locator("#stop-chat").click()
    expect(page.get_by_role("button", name="重试这一轮")).to_be_visible()
    expect(page.locator(".message-error")).to_contain_text("已停止")
    page.locator("#new-chat").click()
    expect(page.locator(".chat-welcome")).to_be_visible()
    page.locator("#chat-history").select_option(index=1)
    expect(page.locator(".chat-message")).to_have_count(6)
    send_bounds = page.locator("#send-chat").bounding_box()
    assert send_bounds["y"] + send_bounds["height"] <= 1000, "long chat pushes composer out of desktop viewport"
    assert page.locator(".library-bottom").bounding_box()["y"] < 1000
    page.locator("#auto-summary").uncheck(force=True)

    page.locator("#chat-input").fill("模拟网络断开")
    page.locator("#send-chat").click()
    expect(page.locator(".message-error").last).to_contain_text("网络连接被中断")
    expect(page.locator(".message-error").last).not_to_contain_text("fetch failed")
    expect(page.get_by_role("button", name="重试这一轮")).to_be_visible()
    page.get_by_role("button", name="检查网络连接").click()
    expect(page.locator("#settings-dialog")).to_be_visible()
    expect(page.locator("#network-settings")).to_be_visible()
    page.locator("#settings-dialog [data-close]").click()
    page.screenshot(path=str(ARTIFACTS / "10-readable-network-error.png"), full_page=True)

    page.locator("#settings-button").click()
    expect(page.locator("#settings-dialog")).to_be_visible()
    expect(page.locator("#network-settings")).to_be_visible()
    page.locator("#network-mode").select_option("manual")
    page.locator("#network-url").fill("http://127.0.0.1:45678")
    page.locator("#save-network").click()
    expect(page.locator("#network-status")).to_contain_text("指定本机代理")
    page.screenshot(path=str(ARTIFACTS / "07-network-settings.png"), full_page=True)
    page.locator("#network-mode").select_option("direct")
    page.locator("#save-network").click()
    expect(page.locator("#network-status")).to_contain_text("系统网络")
    page.get_by_role("button", name="浏览器与 Obsidian").click()
    expect(page.locator("#vault-info")).to_contain_text(".test-vault")
    page.locator("#settings-dialog [data-close]").click()
    page.set_viewport_size({"width": 400, "height": 900})
    page.locator("#show-chat").click()
    page.screenshot(path=str(ARTIFACTS / "04-sidebar-width.png"), full_page=True)
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "sidebar overflows horizontally"
    expect(page.locator("#chat-input")).to_be_visible()
    assert page.locator("#send-chat").bounding_box()["y"] < 900
    page.locator("#show-notes").click()
    expect(page.locator("#note-title")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "notes overflow horizontally"
    assert not errors, errors
    print(json.dumps({"result": "passed", "checks": ["first-run", "new-note", "manual-capture", "edit-save", "local-image", "draft-review", "batch-accept", "outline-conversion", "mubu-copy", "settings", "network-settings", "400px-layout", "streaming-chat", "chat-selection-to-note", "chat-auto-draft", "chat-preserves-unsaved-editor", "chat-history-reload", "chat-stop-retry-control", "new-chat-and-switch", "mobile-pane-switch", "readable-network-error-and-recovery"], "consoleErrors": errors}, ensure_ascii=False))
    browser.close()
