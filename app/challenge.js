'use strict';
// 源自 ../katabump-main/action_renew.js；保留参考项目的页面验证交互。
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

    // 2. 简单的 attachShadow Hook
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };

                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);

            if (data) {
                console.log('>> 在 frame 中发现 Turnstile。比例:', data);

                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;

                const box = await iframeElement.boundingBox();
                if (!box) continue;

                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);

                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);

                const client = await page.context().newCDPSession(page);
                try {
                    await client.send('Input.dispatchMouseEvent', {
                        type: 'mousePressed',
                        x: clickX,
                        y: clickY,
                        button: 'left',
                        clickCount: 1
                    });

                    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

                    await client.send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased',
                        x: clickX,
                        y: clickY,
                        button: 'left',
                        clickCount: 1
                    });

                    console.log('>> CDP 点击已发送。');
                    return true;
                } finally {
                    await client.detach().catch(() => {});
                }
            }
        } catch (e) { }
    }
    return false;
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

module.exports = { INJECTED_SCRIPT, attemptTurnstileCdp, verifyAltcha };
