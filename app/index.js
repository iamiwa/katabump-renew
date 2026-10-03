'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { INJECTED_SCRIPT, attemptTurnstileCdp, verifyAltcha } = require('./challenge');

const BASE = 'https://dashboard.katabump.com';
const ROOT = __dirname;
let activeBrowser;
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);

function settings(env = process.env) {
  const accountDelayMin = Number(env.ACCOUNT_DELAY_MIN_SECONDS || 300);
  const accountDelayMax = Number(env.ACCOUNT_DELAY_MAX_SECONDS || 600);
  if (![accountDelayMin, accountDelayMax].every(n => Number.isInteger(n) && n >= 0 && n <= 3600) || accountDelayMin > accountDelayMax) throw new Error('账号间隔必须为 0–3600 秒的整数，且最小值不能大于最大值');
  if (!!env.TG_BOT_TOKEN !== !!env.TG_CHAT_ID) throw new Error('TG_BOT_TOKEN 和 TG_CHAT_ID 必须同时填写');
  let proxy;
  if (env.HTTP_PROXY) {
    try {
      const url = new URL(env.HTTP_PROXY);
      if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw new Error();
      proxy = { server: url.origin, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    } catch { throw new Error('HTTP_PROXY 格式错误，请使用 http(s)://[用户名:密码@]主机:端口'); }
  }
  return { accountDelayMin, accountDelayMax, proxy, token: env.TG_BOT_TOKEN, chat: env.TG_CHAT_ID };
}
function users(file = path.join(ROOT, 'login.json')) {
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('无法读取 login.json，请创建文件、填写账号并确认容器用户有读取权限'); }
  if (!Array.isArray(list) || !list.length || list.some(u => !u || typeof u.username !== 'string' || !u.username.trim() || typeof u.password !== 'string' || !u.password || u.username === 'your_email@example.com')) {
    throw new Error('login.json 必须是非空账号数组，每项填写 username 和 password，不能使用示例账号');
  }
  if (new Set(list.map(u => u.username)).size !== list.length) throw new Error('login.json 包含重复账号');
  return list;
}
function redact(message, accounts, config) {
  let text = String(message);
  for (const value of [...accounts.flatMap(u => [u.username, u.password]), config.token, config.proxy?.username, config.proxy?.password].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(value).join('[隐藏]');
  return text;
}
function accountId(user) { return crypto.createHash('sha256').update(user.username).digest('hex').slice(0, 16); }
function beijingDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function nextRunAt(now = new Date()) {
  const next = new Date(`${beijingDate(now)}T10:00:00+08:00`);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
function loadAccounts() {
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/accounts.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('无法读取 data/accounts.json，请检查本地日期记录');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([id, entry]) =>
    !/^[a-f0-9]{16}$/.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry) ||
    (entry.expiry != null && !validDate(entry.expiry)) ||
    (entry.lastAttemptDate != null && !validDate(entry.lastAttemptDate)))) throw new Error('data/accounts.json 格式或日期无效，请检查本地日期记录');
  return value;
}
function cachedSkip(entry, now = new Date()) {
  const today = beijingDate(now);
  if (entry?.expiry) {
    const result = expiryDecision(`Expiry: ${entry.expiry}`, now);
    if (result.status === 'skipped') return { ...result, detail: `${result.detail}；使用本地记录，未登录` };
  }
  if (entry?.lastAttemptDate >= today) return { status: 'skipped', detail: '北京时间今天已处理，等待下一天 10:00，未登录' };
  if (entry?.expiry && now < new Date(`${today}T10:00:00+08:00`)) return { status: 'skipped', detail: '已有 Expiry 记录，等待北京时间今天 10:00，未登录' };
  return null;
}
function resultFrom(text, url) {
  const notDue = text.match(/You can't renew your server yet[^\r\n]*/i);
  if (notDue) {
    const available = notDue[0].match(/\bas of\s+(.+?)(?:\s+\(|$)/i)?.[1]?.trim();
    return { status: 'skipped', detail: '尚未到可续期时间' + (available ? `；页面提示可续期时间：${available.slice(0, 160)}` : '') };
  }
  // 模态框关闭不能单独证明续期成功，必须看到页面的明确成功提示。
  if (/\b(?:server\s+(?:has\s+been\s+)?(?:successfully\s+)?renewed|(?:renewed|renewal)\s+(?:is\s+)?success(?:fully|ful)?|successfully\s+renewed)\b/i.test(text)) return { status: 'renewed', detail: '页面确认续期成功' };
  if (/Incorrect password or no account/i.test(text)) return { status: 'failed', detail: '账号或密码错误' };
  const parsed = new URL(url);
  if (parsed.searchParams.has('renew-error')) return { status: 'failed', detail: '页面返回 renew-error，请检查截图' };
  return null;
}
function expiryDecision(text, now = new Date()) {
  const values = [...text.matchAll(/(?:^|\n)[\t ]*Expiry[\t ]*[:：]?[\t ]*(?:\r?\n[\t ]*)*([^\r\n]*)/gi)].map(match => match[1].trim());
  if (values.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(values[0])) {
    return { status: 'failed', detail: '未读取到唯一有效的 Expiry 日期（YYYY-MM-DD），未点击 Renew，请检查截图' };
  }
  const expiry = values[0];
  if (!validDate(expiry)) {
    return { status: 'failed', detail: 'Expiry 日期无效，未点击 Renew，请检查截图' };
  }
  // 用 UTC 计算日期的前一天，当前日期固定按北京时间。
  const date = new Date(`${expiry}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  const renewFrom = date.toISOString().slice(0, 10);
  const today = beijingDate(now);
  const eligible = today >= renewFrom;
  return { status: eligible ? 'eligible' : 'skipped', expiry, renewFrom,
    detail: `Expiry：${expiry}；可尝试日期：${renewFrom}；北京时间日期：${today}；${eligible ? '已到可尝试日期' : '尚未到可尝试日期，未点击 Renew'}` };
}
async function launch(config) {
  const { chromium } = require('playwright-extra');
  if (!launch.initialized) { chromium.use(require('puppeteer-extra-plugin-stealth')()); launch.initialized = true; }
  return chromium.launch({ headless: false, proxy: config.proxy, timeout: 60000, args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720'] });
}
async function verify(page, required = false, scope = page) {
  if (!required && !await scope.locator('iframe[src*="challenges.cloudflare.com"], [name="cf-turnstile-response"]').count()) return true;
  let clicked = false;
  for (let i = 0; i < 20; i++) {
    const complete = await scope.locator('[name="cf-turnstile-response"]').evaluateAll(inputs => inputs.some(input => input.value?.trim()));
    if (complete) return true;
    if (!clicked) clicked = await attemptTurnstileCdp(page);
    await page.waitForTimeout(1000);
  }
  return false;
}
async function renewAccount(page, user, { rememberExpiry = () => {}, allowRenew = true, reuseSession = false, onAuthenticated = async () => {}, forgetSession = () => {} } = {}) {
  const pause = async action => {
    const seconds = crypto.randomInt(2, 6);
    log(`等待 ${seconds} 秒后${action}`);
    // 页面关闭时等待会中断，停止容器后不会继续后面的操作。
    await page.waitForTimeout(seconds * 1000);
  };
  const see = page.getByRole('link', { name: 'See', exact: true }).first();
  let authenticated = false;
  if (reuseSession) {
    await pause('使用已保存登录状态打开控制台');
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await pause('检查会话页面验证');
    if (!await verify(page)) return { status: 'failed', detail: '会话页面验证未完成' };
    const email = page.getByRole('textbox', { name: 'Email', exact: true });
    try { await see.or(email).first().waitFor({ state: 'visible', timeout: 20000 }); }
    catch { return { status: 'failed', detail: '复用会话后未找到服务器入口或登录表单，请检查截图' }; }
    authenticated = await see.isVisible();
    if (authenticated) log('已复用登录状态，无需重新填写账号密码');
    else { forgetSession(); log('保存的登录状态已失效，重新登录'); }
  }
  if (!authenticated) {
    await pause('打开登录页面');
    await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
    await pause('检查登录页面验证');
    if (!await verify(page)) return { status: 'failed', detail: '登录页面验证未完成' };
    await pause('填写邮箱');
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(user.username);
    await pause('填写密码');
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(user.password);
    await pause('检查提交前的登录验证');
    if (!await verify(page)) return { status: 'failed', detail: '登录页面验证未完成' };
    await pause('提交登录');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
  }
  try { await see.waitFor({ state: 'visible', timeout: 20000 }); }
  catch {
    const result = resultFrom(await page.locator('body').innerText(), page.url());
    return result && result.status !== 'renewed' ? result : { status: 'failed', detail: '未找到服务器入口，登录或页面验证未完成' };
  }
  await onAuthenticated();
  const dashboardNotice = resultFrom(await page.locator('.alert:visible, [role="alert"]:visible').allInnerTexts().then(texts => texts.join('\n')), page.url());
  // 与参考项目一致，每个账号处理首页的第一个服务器。
  await pause('进入服务器详情');
  await see.click();
  const detailUrl = new URL(page.url());
  detailUrl.searchParams.delete('renew-error');
  const renew = page.getByRole('button', { name: 'Renew', exact: true }).first();
  await renew.waitFor({ state: 'visible', timeout: 15000 });
  const serverNotice = resultFrom(await page.locator('.alert:visible, [role="alert"]:visible').allInnerTexts().then(texts => texts.join('\n')), page.url());
  const expiry = expiryDecision(await page.locator('body').innerText());
  if (expiry.expiry) rememberExpiry(expiry.expiry);
  if (expiry.status !== 'eligible') return expiry;
  if (serverNotice?.status === 'skipped' || dashboardNotice?.status === 'skipped') return serverNotice?.status === 'skipped' ? serverNotice : dashboardNotice;
  log(expiry.detail);
  if (!allowRenew) return { status: 'skipped', expiry: expiry.expiry, detail: '已记录 Expiry，等待北京时间 10:00 再尝试续期，未点击 Renew' };
  await pause('打开续期弹窗');
  await renew.click();
  const modal = page.locator('#renew-modal');
  await modal.waitFor({ state: 'visible', timeout: 10000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const modalNotice = resultFrom(await modal.innerText(), page.url());
    if (modalNotice?.status === 'skipped') return modalNotice;
    await pause('检查续期验证');
    // 首次提交后才出现的验证在当前页面完成，不能刷新丢掉控件和 token。
    if (attempt > 0) {
      try { await modal.locator('altcha-widget, [name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"]').first().waitFor({ state: 'attached', timeout: 20000 }); }
      catch { return { status: 'failed', detail: '续期验证控件未出现，未继续提交' }; }
    }
    const altcha = await verifyAltcha(modal);
    if (altcha === false) return { status: 'failed', detail: 'ALTCHA 验证未完成，未继续提交' };
    if (!await verify(page, attempt > 0 && altcha === null, modal)) return { status: 'failed', detail: '页面验证未完成，未继续提交' };
    await pause(`提交续期（第 ${attempt + 1}/3 次）`);
    const hadCaptchaError = /Please complete the captcha to continue/i.test(await page.locator('body').innerText());
    await modal.getByRole('button', { name: 'Renew', exact: true }).click();
    let captcha = false;
    for (let i = 0; i < 20; i++) {
      const text = await page.locator('body').innerText();
      const result = resultFrom(text, page.url());
      if (result?.status === 'renewed') {
        // 成功后先清除旧日期；新日期必须重新读取，不能自行加天数。
        rememberExpiry(null);
        let updated;
        try {
          await pause('重新读取续期后的 Expiry');
          await page.goto(detailUrl.href, { waitUntil: 'domcontentloaded' });
          await page.getByRole('button', { name: 'Renew', exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
          updated = expiryDecision(await page.locator('body').innerText());
        } catch { /* 续期已确认；读取失败留待下一个计划日检查。 */ }
        if (updated?.expiry > expiry.expiry) {
          rememberExpiry(updated.expiry);
          return { ...result, expiry: updated.expiry, detail: `${result.detail}；新 Expiry：${updated.expiry}` };
        }
        return { ...result, detail: `${result.detail}；新 Expiry 未确认，已清除旧记录，下次北京时间 10:00 重新读取` };
      }
      if (result?.status === 'skipped') return result;
      captcha = /Please complete the captcha to continue/i.test(text);
      if (captcha) {
        // 异步提交期间旧错误可能仍显示，先等本次响应，不能立即重复提交。
        if (!hadCaptchaError) break;
      } else if (result) return result;
      await page.waitForTimeout(500);
    }
    if (!captcha) return { status: 'unconfirmed', detail: '已提交，但没有明确成功提示；请检查截图，未计为成功' };
  }
  return { status: 'failed', detail: '页面验证未完成，已停止本轮重试' };
}
async function telegram(config, message, screenshot) {
  if (!config.token) return;
  try {
    const form = new FormData();
    form.set('chat_id', config.chat);
    if (screenshot && fs.existsSync(screenshot)) {
      form.set('caption', message);
      form.set('photo', new Blob([fs.readFileSync(screenshot)], { type: 'image/png' }), 'result.png');
    } else form.set('text', message);
    const response = await fetch(`https://api.telegram.org/bot${config.token}/${form.has('photo') ? 'sendPhoto' : 'sendMessage'}`, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
    if (!response.ok || !(await response.json()).ok) throw new Error();
  } catch { log('Telegram 发送失败（续期结果不受影响）'); }
}
async function runRound(config, signal) {
  const outputDir = path.join(ROOT, 'data');
  const results = [];
  const report = { startedAt: new Date().toISOString(), finishedAt: null, status: 'running', complete: false, results };
  let accounts = [], browser, timeout;
  const close = () => void browser?.close().catch(() => {});
  const save = () => writeJson(path.join(outputDir, 'last-run.json'), report);
  try {
    // 先替换上一轮记录，账号读取或浏览器启动失败也属于本轮结果。
    save();
    accounts = users();
    const cached = loadAccounts();
    const saveAccounts = () => writeJson(path.join(outputDir, 'accounts.json'), cached);
    let attempted = false;
    signal.throwIfAborted();
    log(`开始本轮续期，共 ${accounts.length} 个账号`);
    signal.addEventListener('abort', close, { once: true });
    for (let i = 0; i < accounts.length; i++) {
      signal.throwIfAborted();
      const user = accounts[i], id = accountId(user);
      const skip = cachedSkip(cached[id]);
      if (skip) {
        log(`账号 ${i + 1}: ${skip.status} — ${skip.detail}`);
        results.push({ account: id, ...skip, cached: true }); save();
        continue;
      }
      if (attempted) {
        const seconds = crypto.randomInt(config.accountDelayMin, config.accountDelayMax + 1);
        log(`等待 ${seconds} 秒后处理账号 ${i + 1}/${accounts.length}，预计开始时间：${new Date(Date.now() + seconds * 1000).toISOString()}`);
        await delay(seconds * 1000, null, { signal });
      }
      signal.throwIfAborted();
      attempted = true;
      const today = beijingDate();
      const allowRenew = Date.now() >= new Date(`${today}T10:00:00+08:00`).getTime();
      // 先持久化当天尝试标志，失败或重启也不会在当天重复登录。
      if (allowRenew) { cached[id] = { ...cached[id], lastAttemptDate: today }; saveAccounts(); }
      const rememberExpiry = expiry => { cached[id] = { ...cached[id], expiry }; saveAccounts(); };
      browser = activeBrowser = await launch(config);
      if (signal.aborted) { close(); signal.throwIfAborted(); }
      // 15 分钟限制只覆盖当前账号处理，不计入账号之间的等待。
      timeout = setTimeout(close, 15 * 60000);
      if (!browser.isConnected()) throw new Error('浏览器已退出');
      const sessionFile = path.join(outputDir, 'sessions', `${id}.json`);
      const contextOptions = { viewport: { width: 1280, height: 720 }, locale: 'en-US' };
      let reuseSession = fs.existsSync(sessionFile), context;
      try { context = await browser.newContext({ ...contextOptions, ...(reuseSession ? { storageState: sessionFile } : {}) }); }
      catch {
        // 恢复错误可能含 Cookie 等内容，不能直接输出原始异常。
        if (!reuseSession || signal.aborted || !browser.isConnected()) throw new Error('无法启动账号浏览器上下文');
        log(`账号 ${i + 1} 登录状态无法加载，本轮重新登录`);
        fs.rmSync(sessionFile, { force: true }); reuseSession = false;
        context = await browser.newContext(contextOptions);
      }
      await context.addInitScript(INJECTED_SCRIPT);
      const page = await context.newPage();
      page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(45000);
      let result;
      let authenticated = false;
      const saveSession = async () => {
        try { writeJson(sessionFile, await context.storageState({ indexedDB: true })); }
        catch { log(`账号 ${i + 1} 登录状态保存失败，下次可能需要重新登录`); }
      };
      const screenshot = path.join(outputDir, `${id}.png`);
      fs.rmSync(screenshot, { force: true });
      try { result = await renewAccount(page, user, {
        rememberExpiry, allowRenew, reuseSession,
        onAuthenticated: async () => { authenticated = true; await saveSession(); },
        forgetSession: () => fs.rmSync(sessionFile, { force: true }),
      }); }
      catch (error) { result = { status: 'failed', detail: redact(error.message, accounts, config).slice(0, 400) }; }
      finally {
        if (authenticated && !signal.aborted) await saveSession();
        try { await page.screenshot({ path: screenshot, fullPage: true, timeout: 10000 }); }
        catch { log(`账号 ${i + 1} 截图失败`); }
        await context.close().catch(() => {});
        clearTimeout(timeout); timeout = undefined;
        await browser.close().catch(() => {}); browser = activeBrowser = undefined;
      }
      log(`账号 ${i + 1}: ${result.status} — ${result.detail}`);
      results.push({ account: id, ...result });
      save();
      if (!signal.aborted) await telegram(config, `Katabump 账号 ${i + 1}: ${result.status}\n${result.detail}`, screenshot);
    }
    signal.throwIfAborted();
    report.complete = true;
    report.status = results.every(r => ['renewed', 'skipped'].includes(r.status)) ? 'completed' : 'failed';
  } catch (error) {
    report.status = signal.aborted ? 'interrupted' : 'failed';
    report.error = redact(error.message, accounts, config).slice(0, 400);
    log(`本轮 ${report.status}: ${report.error}`);
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', close);
    await browser?.close().catch(() => {}); activeBrowser = undefined;
    report.finishedAt = new Date().toISOString();
    try { save(); }
    catch {
      report.status = 'failed';
      report.error = '无法保存本轮结果，请检查数据卷权限和剩余空间';
      log(report.error);
    }
    if (report.error && !signal.aborted) await telegram(config, `Katabump 本轮失败\n${report.error}`);
  }
  return report.status === 'completed';
}
async function smoke(config) {
  const browser = activeBrowser = await launch(config);
  try {
    const page = await browser.newPage();
    await page.setContent('<title>Katabump Docker smoke</title><h1>Browser ready</h1>');
    if (await page.title() !== 'Katabump Docker smoke') throw new Error('浏览器自检失败');
    log(`Chromium 自检通过，Node ${process.version}，架构 ${process.arch}（未访问 Katabump）`);
  } finally { await browser.close(); activeBrowser = undefined; }
}
async function main() {
  const mode = process.argv[2] || '--daemon';
  if (!['--daemon', '--once', '--check', '--smoke'].includes(mode)) throw new Error('用法：--daemon | --once | --check | --smoke');
  const config = settings();
  const controller = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => {
    controller.abort(); void activeBrowser?.close().catch(() => {});
  });
  if (mode === '--smoke') return smoke(config);
  if (mode === '--check') { users(); await smoke(config); log('账号配置及浏览器检查通过，未登录、未续期'); return; }
  do {
    const startedAt = new Date();
    let success = false;
    try { success = await runRound(config, controller.signal); }
    catch (error) {
      if (controller.signal.aborted) break;
      let accounts = [];
      try { accounts = users(); } catch { /* 文件错误不含凭据，下一轮重新读取。 */ }
      log(redact(error.message, accounts, config));
    }
    if (mode === '--once') { process.exitCode = success ? 0 : 1; break; }
    if (controller.signal.aborted) break;
    // 从本轮开始时计算，首次读取日期跨过 10 点时立即补上该轮，避免漏掉当天。
    const next = nextRunAt(startedAt);
    log(`本轮结束，下次运行时间：${beijingDate(next)} 10:00:00（北京时间）`);
    try { await delay(Math.max(0, next.getTime() - Date.now()), null, { signal: controller.signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  } while (!controller.signal.aborted);
}
if (require.main === module) main().catch(error => {
  let accounts = [], config = {};
  try { accounts = users(); } catch {}
  try { config = settings(); } catch {}
  console.error(`启动失败：${redact(error.message, accounts, config)}`);
  process.exitCode = 1;
});
module.exports = { settings, users, redact, resultFrom, expiryDecision, beijingDate, nextRunAt, cachedSkip, accountId, renewAccount, launch, smoke, runRound };
