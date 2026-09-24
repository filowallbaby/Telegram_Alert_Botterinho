"""Optional UI test for the map page, run fully offline in headless Chromium.

It loads the real HTML, CSS and JS from public/, but fetch() and the Telegram WebApp
object are replaced with fakes, and Leaflet is not loaded. So it covers the page logic,
not the map rendering, the HTTP headers or the Telegram login.

    pip install playwright
    playwright install chromium
    python tests/browser-smoke.py

Set CHROMIUM_PATH to use a Chromium you already have instead of the Playwright one.
"""
import json
import os
import re
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
html = (ROOT / 'public/index.html').read_text(encoding='utf-8')
# Drop external scripts and stylesheets; app.js is injected after the fakes are in place.
html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S | re.I)
html = re.sub(r'<link\b[^>]*rel="stylesheet"[^>]*>', '', html, flags=re.I)
html = html.replace('</head>', '<style>' + (ROOT / 'public/styles.css').read_text(encoding='utf-8') + '</style></head>')
app_js = (ROOT / 'public/app.js').read_text(encoding='utf-8')
now = int(time.time())
categories = {
    'accident': {'label': 'Accident', 'color': '#db4853'},
    'traffic': {'label': 'Traffic jam', 'color': '#dc8e22'},
    'roadworks': {'label': 'Roadworks', 'color': '#367cdc'}
}
base = dict(latitude=41.90, longitude=12.49, reported_by='Test user',
            observed_at=now-300, created_at=now-300, expires_at=now+3600,
            last_confirmed_at=None, resolved_at=None, clear_votes=0,
            message_url='https://t.me/c/123456/1')
events = [
    dict(base, id=3, category='accident', description='TEST <img src=x onerror="window.__xss=true">', status='active', confirmations=2),
    dict(base, id=2, category='traffic', description='TEST traffic jam', status='active', confirmations=1),
    dict(base, id=1, category='roadworks', description='TEST expired roadworks', status='expired', confirmations=0)
]
fixture = {'events': events, 'categories': categories, 'now': now}
passed = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None,
                                headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    context.route('**/*', lambda route: route.abort())

    def prepare_page(authenticated):
        page = context.new_page()
        page.set_content(html)
        page.evaluate('fixture => { window.__fixture = fixture; }', fixture)
        if authenticated:
            page.evaluate("""window.Telegram={WebApp:{initData:'FAKE_INIT_DATA',
              initDataUnsafe:{},ready(){},expand(){},onEvent(){},openTelegramLink(){}}};""")
        page.evaluate("""() => {
          window.__control={deny:false,fail:false,page:false,calls:0};
          window.fetch=async function(url) {
            const control=window.__control, fixture=window.__fixture;
            control.calls++;
            const response=(status,data)=>new Response(JSON.stringify(data),
                {status,headers:{'Content-Type':'application/json'}});
            if(control.deny) return response(403,{error:'The map is only available to group members.'});
            if(control.fail) return response(503,{error:'Fake temporary error.'});
            const history=String(url).includes('mode=7d');
            let selected=history?fixture.events:fixture.events.slice(0,2), cursor=null;
            if(control.page) {
              if(String(url).includes('before=')) selected=fixture.events.slice(2);
              else {selected=fixture.events.slice(0,2);cursor=2;}
            }
            return response(200,{events:selected,next_cursor:cursor,generated_at:fixture.now,
              title:'Test group',center:[41.90,12.49],zoom:12,time_zone:'Europe/Rome',
              mode:history?'7d':'active',categories:fixture.categories});
          };
        }""")
        return page

    page = prepare_page(False)
    page.add_script_tag(content=app_js)
    assert page.locator('#access').is_visible() and page.locator('#application').is_hidden()
    assert 'Open the Telegram bot' in page.locator('#access-text').inner_text()
    assert page.evaluate('window.__control.calls') == 0
    passed.append('Without a Telegram login: no data and no API calls')
    page.close()

    page = prepare_page(True)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_script_tag(content=app_js)
    page.wait_for_function("document.querySelectorAll('.event-card').length === 2")
    assert page.locator('#map-warning').is_visible()
    passed.append('The list works even when Leaflet is not available')

    page.locator('#category').select_option('traffic')
    assert page.locator('.event-card').count() == 1
    page.locator('#category').select_option('all')
    assert page.locator('.event-card').count() == 2
    passed.append('Category filter updates the list and the counters')

    page.locator('.event-card').first.click()
    assert page.locator('#detail').is_visible()
    assert '<img src=x' in page.locator('#detail-content').inner_text()
    assert page.locator('#detail-content img').count() == 0
    assert page.evaluate('window.__xss === undefined')
    page.locator('#close-detail').click()
    passed.append('HTML in a note is shown as text, not executed')

    page.locator('[data-mode="7d"]').click()
    page.wait_for_function("document.querySelectorAll('.event-card').length === 3")
    assert page.locator('#count').inner_text() == '3'
    passed.append('The 7 day range includes expired reports')

    page.evaluate('window.__control.fail = true')
    page.locator('[data-mode="active"]').click()
    page.wait_for_function("!document.getElementById('error').hidden")
    assert page.locator('[data-mode="7d"]').get_attribute('aria-pressed') == 'true'
    page.evaluate('window.__control.fail = false')
    passed.append('On an API error the selected range goes back to the data on screen')

    page.evaluate('window.__control.page = true')
    page.locator('[data-mode="active"]').click()
    page.wait_for_function("!document.getElementById('more').hidden")
    page.locator('#more').click()
    page.wait_for_function("document.querySelectorAll('.event-card').length === 3")
    assert page.locator('#more').is_hidden()
    passed.append('Load more adds the next page without duplicates')

    for width in [320, 390, 1280]:
        page.set_viewport_size({'width': width, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'Horizontal overflow at {width}px'
    passed.append('No horizontal scrolling at 320, 390 and 1280 px')

    page.evaluate('window.__control.deny = true')
    page.locator('#refresh').click()
    page.wait_for_function("document.getElementById('application').hidden")
    assert page.locator('.event-card').count() == 0
    assert page.locator('#access').is_visible()
    passed.append('A 403 clears the reports from the screen')

    assert not errors, errors
    passed.append('No JavaScript errors')
    browser.close()

print(json.dumps({'passed': len(passed), 'checks': passed}, indent=2))
