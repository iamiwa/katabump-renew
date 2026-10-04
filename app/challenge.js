'use strict';
// Turnstile 交互：Hook attachShadow 记录 iframe 内的 shadow root，点击前按实时布局取坐标。
// Turnstile 的 input[type=checkbox] 是覆盖整条标签（含文字）的透明控件，宽度随文字长度变化，
// 其几何中心落在 "Verify you are human" 文字上；可见的方框位于该控件左端，边长等于控件高度，
// 所以点击点取左端正方形中心，而不是控件中心。
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    // 1. 模拟鼠标屏幕坐标
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);

        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    // 2. 记录 shadow root；位置在点击时再读取，避免缓存渲染早期的过期坐标
    try {
        const originalAttachShadow = Element.prototype.attachShadow;

        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);

            if (shadowRoot) {
                (window.__turnstile_roots = window.__turnstile_roots || []).push(shadowRoot);
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

// 在 Turnstile iframe 内实时读取复选框，返回可见方框中心的 iframe 坐标。
async function checkboxPoint(frame) {
    return frame.evaluate(() => {
        for (const root of (window.__turnstile_roots || [])) {
            for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) {
                const rect = checkbox.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                return { x: rect.left + rect.height / 2, y: rect.top + rect.height / 2, checked: checkbox.checked };
            }
        }
        return null;
    }).catch(() => null);
}

// 点击尚未勾选的 Turnstile 复选框；已勾选时返回 pending，交由调用方等待验证结果。
async function clickTurnstileCheckbox(page) {
    let seen = false;
    for (const frame of page.frames()) {
        const point = await checkboxPoint(frame);
        if (!point) continue;
        seen = true;
        if (point.checked) continue;

        const iframeElement = await frame.frameElement().catch(() => null);
        const box = iframeElement && await iframeElement.boundingBox();
        if (!box) continue;

        const clickX = box.x + point.x;
        const clickY = box.y + point.y;
        console.log(`>> 点击 Turnstile 复选框: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
        await page.mouse.click(clickX, clickY, { delay: 50 + Math.random() * 100 });
        return 'clicked';
    }
    return seen ? 'pending' : 'absent';
}


// 使用 ALTCHA 自带的验证方法完成计算，不把勾选或 disabled 当作验证成功。
// https://altcha.org/docs/integration/widget/
async function verifyAltcha(modal) {
    const widget = modal.locator('altcha-widget').first();
    if (!await widget.count()) return null;
    let started = false;
    for (let i = 0; i < 120; i++) {
        const state = await widget.evaluate(el => typeof el.getState === 'function' ? el.getState() : 'loading');
        if (state === 'verified') return true;
        if (state === 'error' || state === 'code') return false;
        if (!started && ['unverified', 'expired'].includes(state)) {
            started = await widget.evaluate(el => {
                if (typeof el.verify !== 'function') return false;
                Promise.resolve(el.verify()).catch(() => {});
                return true;
            });
        }
        await modal.page().waitForTimeout(1000);
    }
    return false;
}

module.exports = { INJECTED_SCRIPT, clickTurnstileCheckbox, verifyAltcha };
