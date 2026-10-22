"""Real selection/contextmenu checks against the isolated synthetic model."""
import json
import re
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeout

ROOT = Path(__file__).resolve().parent.parent
URL = 'http://127.0.0.1:17862'
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    context = browser.new_context(viewport={'width': 1540, 'height': 1050},permissions=['clipboard-read','clipboard-write'])
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL)
    try: page.wait_for_load_state('networkidle', timeout=1200)
    except PlaywrightTimeout: pass
    expect(page.locator('#connection-label')).to_have_text('本地文件模式')

    def select(root, text, occurrence=0):
        bounds = page.evaluate('''async ({root, text, occurrence}) => {
          const parent=document.querySelector(root), walker=document.createTreeWalker(parent,NodeFilter.SHOW_TEXT);
          let n, seen=0;
          while(n=walker.nextNode()) {
            let offset=-1;
            while((offset=n.textContent.indexOf(text,offset+1))>=0) {
              if(seen++!==occurrence) continue;
              const range=document.createRange(); range.setStart(n,offset);range.setEnd(n,offset+text.length);
              n.parentElement.scrollIntoView({block:'center',inline:'nearest'});
              const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              const box=range.getBoundingClientRect();return {x:box.x+Math.min(8,box.width/2),y:box.y+box.height/2};
            }
          } throw new Error('Selection text not found: '+text);
        }''', {'root': root, 'text': text, 'occurrence': occurrence})
        page.mouse.click(bounds['x'], bounds['y'], button='right')
        expect(page.locator('#selection-menu')).to_be_visible()

    def new_note(title, mode='markdown'):
        page.locator('#new-note').click(); page.locator('#new-title').fill(title)
        page.locator(f'input[name=mode][value={mode}]').check()
        page.get_by_role('button', name='建立笔记', exact=True).click()
        expect(page.locator('#note-title')).to_have_text(title)

    def add(text):
        page.locator('#import-button').click();page.locator('#import-text').fill(text)
        page.get_by_role('button', name='加入当前笔记').click()
        expect(page.locator('#import-dialog')).not_to_be_visible()

    page.locator('#chat-model').click();page.locator('#provider').select_option('deepseek')
    page.locator('#model').fill('synthetic-test');page.locator('#api-key').fill('isolated-not-a-real-key');page.locator('#calls-limit').fill('100')
    page.locator('#settings-form button[type=submit]').click();page.locator('#settings-dialog [data-close]').click()
    new_note('右键操作 · 普通笔记 '+str(int(time.time()*1000)))
    page.locator('#new-chat').click();page.locator('#chat-input').fill('解释概念与条件')
    page.locator('#send-chat').click();expect(page.locator('#stop-chat')).to_be_hidden()
    expect(page.locator('.chat-message.assistant .message-body')).to_contain_text('先理解概念')
    expect(page.locator('.streaming-text')).to_have_count(0)
    before_calls=context.request.get(URL+'/api/state').json()['usage']['calls']
    select('.chat-message.assistant .message-body','先理解概念，再核对适用条件。')
    expect(page.locator('#menu-chat-format')).to_be_visible();expect(page.locator('#menu-chat-simplify')).to_be_visible()
    page.screenshot(path=str(ROOT/'.artifacts/11-chat-context-menu.png'),full_page=True)
    page.locator('#menu-chat-add').click();expect(page.locator('#preview')).to_contain_text('先理解概念，再核对适用条件。')
    assert context.request.get(URL+'/api/state').json()['usage']['calls']==before_calls

    select('.chat-message.assistant .message-body','条件与例外需要保留。')
    page.locator('#menu-chat-format').click();expect(page.locator('#edit-dialog')).to_be_visible()
    expect(page.locator('#edit-apply')).to_be_enabled();expect(page.locator('#edit-original')).to_have_text('条件与例外需要保留。')
    expect(page.locator('#preview')).not_to_contain_text('排版后的要点')
    page.screenshot(path=str(ROOT/'.artifacts/12-selection-ai-preview.png'),full_page=True)
    page.locator('#edit-apply').click();expect(page.locator('#preview')).to_contain_text('排版后的要点')
    select('.chat-message.assistant .message-body','可以把这一段选入笔记。')
    page.locator('#menu-chat-simplify').click();expect(page.locator('#edit-apply')).to_be_enabled()
    expect(page.locator('#edit-rendered')).to_contain_text('精简要点');page.locator('#edit-apply').click()
    expect(page.locator('#preview')).to_contain_text('精简要点')

    fixture='''## 对照练习

相同词 在第一段。

相同词 在第二段，包含 **重点**、[[已有知识|别名]] 和 $a=b$。

| 项目 | 数值 |
| --- | --- |
| Alpha | 3 |
| Beta | 4 |

## 待修表格

| 项目 | 数值 |
| -- | -- |
| Gamma | 5 |
| Delta | 6 |'''
    add(fixture);expect(page.locator('#preview table')).to_have_count(1)
    page.locator('#preview').scroll_into_view_if_needed()
    select('#preview','相同词',1);page.get_by_role('menuitem',name='文字颜色：红色',exact=True).click()
    expect(page.locator('#editor')).to_have_value(re.compile('相同词 在第一段。[\\s\\S]*<span style="color:#b4473d">相同词</span>'))
    expect(page.locator('#preview span').filter(has_text='相同词')).to_have_count(1)
    page.screenshot(path=str(ROOT/'.artifacts/13-note-color-and-table.png'),full_page=True)
    page.locator('#undo-note').click();expect(page.locator('#preview span').filter(has_text='相同词')).to_have_count(0)

    select('#preview','别名');page.get_by_role('menuitem',name='文字颜色：蓝色',exact=True).click()
    expect(page.locator('#preview a.wiki-link')).to_contain_text('别名')
    expect(page.locator('#editor')).to_have_value(re.compile(re.escape('<span style="color:#326ca8">[[已有知识|别名]]</span>')))

    page.locator('#preview p').filter(has_text='Gamma').scroll_into_view_if_needed()
    select('#preview','Gamma');page.locator('#menu-note-format').click();expect(page.locator('#edit-apply')).to_be_enabled()
    expect(page.locator('#edit-original')).to_contain_text('| Gamma | 5 |')
    expect(page.locator('#edit-original')).not_to_contain_text('相同词')
    expect(page.locator('#edit-rendered table')).to_have_count(1)
    page.locator('#edit-apply').click();expect(page.locator('#preview table')).to_have_count(2)
    expect(page.locator('#preview')).to_contain_text('Gamma');expect(page.locator('#preview')).to_contain_text('Delta')

    # Color a row across two cells; pipe delimiters must not become HTML.
    row=page.locator('#preview table').first.locator('tbody tr').first
    row.scroll_into_view_if_needed()
    bounds=row.evaluate('''row=>{const a=row.children[0].firstChild,b=row.children[1].firstChild,r=document.createRange();r.setStart(a,0);r.setEnd(b,b.length);const s=window.getSelection();s.removeAllRanges();s.addRange(r);const x=r.getBoundingClientRect();return {x:x.left+8,y:x.top+8}}''')
    page.mouse.click(bounds['x'],bounds['y'],button='right');page.get_by_role('menuitem',name='文字颜色：绿色',exact=True).click()
    expect(page.locator('#preview table')).to_have_count(2)
    expect(page.locator('#editor')).to_have_value(re.compile(re.escape('| <span style="color:#26744d">Alpha</span> | <span style="color:#26744d">3</span> |')))

    # A concurrent note update cannot be overwritten by an AI preview.
    select('#preview','相同词',0);page.locator('#menu-note-format').click();expect(page.locator('#edit-apply')).to_be_enabled()
    state=context.request.get(URL+'/api/state').json();note_id=state['settings']['targetNoteId']
    detail=context.request.get(URL+f'/api/notes/{note_id}').json()
    assert context.request.put(URL+f'/api/notes/{note_id}',data={'text':detail['text']+'\n外部改动需要保留。\n','expectedHash':detail['hash']}).ok
    page.locator('#edit-apply').click();expect(page.locator('#edit-error')).to_contain_text('已变化')
    page.locator('#edit-cancel').click();expect(page.locator('#preview')).to_contain_text('外部改动需要保留')

    new_note('右键操作 · 大纲 '+str(int(time.time()*1000)), 'outline')
    select('.chat-message.assistant .message-body','条件与例外需要保留。')
    page.locator('#menu-chat-simplify').click();expect(page.locator('#edit-apply')).to_be_enabled()
    page.reload();expect(page.locator('#edit-dialog')).to_be_visible();expect(page.locator('#edit-apply')).to_be_enabled()
    page.locator('#edit-apply').click();expect(page.locator('#preview')).to_contain_text('精简要点')
    raw=page.locator('#editor').input_value();assert all(not line.strip() or line.lstrip().startswith('- ') for line in raw.splitlines())
    page.locator('#copy-note').click();clip=page.evaluate('navigator.clipboard.readText()');assert '<span' not in clip and '精简要点' in clip
    select('#preview','精简要点');page.get_by_role('menuitem',name='文字颜色：紫色',exact=True).click()
    expect(page.locator('#preview span').filter(has_text='精简要点')).to_have_count(1)
    raw=page.locator('#editor').input_value();assert all(not line.strip() or line.lstrip().startswith('- ') for line in raw.splitlines())
    # The menu remains inside a narrow window.
    page.set_viewport_size({'width':400,'height':900});page.locator('#show-notes').click()
    select('#preview','精简要点');bounds=page.locator('#selection-menu').bounding_box()
    assert bounds['x']>=0 and bounds['x']+bounds['width']<=400
    page.keyboard.press('Escape');expect(page.locator('#selection-menu')).not_to_be_visible()
    assert not errors,errors
    print(json.dumps({'result':'passed','checks':['chat-right-click','direct-selection-no-ai','ai-format-preview-apply','ai-simplify','gfm-tables','exact-repeated-text-color','color-undo','colored-wikilink','table-ai-repair','multi-cell-color','concurrent-edit-protection','preview-reload-recovery','outline-format-and-color','400px-menu'],'consoleErrors':errors},ensure_ascii=False))
    browser.close()
