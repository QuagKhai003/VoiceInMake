const { chromium } = require('playwright');
const { OpenAI } = require('openai');

const getClient = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  return new OpenAI({ apiKey });
};

const SYSTEM_PROMPT = `
Bạn là một AI agent điều khiển trình duyệt web để tự động điền hóa đơn.
Bạn nhận ảnh chụp màn hình của trang web và trả về hành động tiếp theo dưới dạng JSON.

QUAN TRỌNG — Bạn chỉ thực hiện MỘT hành động mỗi lần. Hãy chọn hành động ĐÚNG THỨ TỰ:

Quy tắc đăng nhập (PHẢI tuân thủ):
1. Điền tên đăng nhập TRƯỚC
2. Điền mật khẩu SAU
3. CHỈ nhấn nút đăng nhập SAU KHI đã điền CẢ username VÀ password
4. Nếu trong lịch sử đã có "type" cho username nhưng CHƯA có "type" cho password → bước tiếp theo PHẢI là điền password, KHÔNG ĐƯỢC nhấn đăng nhập
5. Nếu đăng nhập thất bại (thông báo lỗi, form đăng nhập vẫn hiển thị sau khi đã nhấn) → dùng "ask_user" để hỏi người dùng thông tin đăng nhập đúng. KHÔNG thử lại cùng credentials.

Quy tắc chung:
- Luôn trả về JSON duy nhất, không markdown
- Phân tích kỹ ảnh chụp màn hình để xác định trạng thái trang
- Nếu thấy trang chủ/dashboard, tìm nút hoặc link tạo hóa đơn mới
- Nếu thấy form hóa đơn, điền từng trường một
- Nếu thấy nút submit/gửi, nhấn nó
- Nếu gặp khó khăn, bị kẹt, hoặc không chắc chắn → dùng action "ask_user" để hỏi người dùng. ĐỪNG lặp lại cùng một hành động thất bại.
- Nếu thấy popup, captcha, OTP, hoặc xác thực 2 bước → dùng "ask_user" để thông báo người dùng

Trả về JSON với cấu trúc:
{
  "action": "click" | "type" | "select" | "scroll" | "wait" | "done" | "error" | "ask_user",
  "target": "mô tả element bằng text/placeholder/label mà bạn thấy trên màn hình",
  "value": "giá trị cần nhập (cho action type/select)",
  "reasoning": "giải thích ngắn gọn bằng tiếng Việt tại sao chọn hành động này",
  "status": "mô tả ngắn gọn trạng thái hiện tại bằng tiếng Việt",
  "question": "câu hỏi cho người dùng (chỉ dùng khi action là ask_user)"
}

Khi action là "done": đã hoàn thành việc điền hóa đơn.
Khi action là "error": gặp lỗi không thể tiếp tục.
Khi action là "ask_user": cần hỏi người dùng để tiếp tục (ví dụ: không biết chọn loại hóa đơn nào, không tìm thấy nút, trang web yêu cầu thông tin bạn không có).
`.trim();

const buildPrompt = (phase, invoiceData, credentials, currentUrl, userInstructions, actionHistory) => {
  let context = `URL hiện tại: ${currentUrl}\n`;

  if (phase === 'login') {
    context += `\nGiai đoạn: ĐĂNG NHẬP
Tên đăng nhập (mới nhất): ${credentials.username}
Mật khẩu (mới nhất): ${credentials.password}
Hãy tìm form đăng nhập và điền thông tin. Nếu trường đã có giá trị cũ, XÓA và điền lại giá trị mới.`;
  } else if (phase === 'navigate') {
    context += `\nGiai đoạn: TÌM TRANG TẠO HÓA ĐƠN
Hãy tìm nút/link để tạo hóa đơn mới. Tìm các từ như: "Tạo hóa đơn", "New invoice", "Lập hóa đơn", "Create", "+", "Thêm mới".`;
  } else if (phase === 'fill') {
    context += `\nGiai đoạn: ĐIỀN THÔNG TIN HÓA ĐƠN
Dữ liệu hóa đơn cần điền:
- Tên người mua: ${invoiceData.buyerName || '(trống)'}
- Mã số thuế: ${invoiceData.taxId || '(trống)'}
- Số VAT: ${invoiceData.vatNumber || '(trống)'}
- Địa chỉ: ${invoiceData.buyerAddress || '(trống)'}
- Loại hóa đơn: ${invoiceData.invoiceType || '(trống)'}
- Ngày phát hành: ${invoiceData.issueDate || '(trống)'}
- Hàng hóa: ${JSON.stringify(invoiceData.lineItems || [])}

Tìm các trường input tương ứng và điền thông tin. Điền từng trường một.
Nếu đã điền hết tất cả, tìm nút gửi/submit và nhấn, sau đó trả về action "done".`;
  }

  // Include action history so AI knows what was already tried
  if (actionHistory && actionHistory.length > 0) {
    const recent = actionHistory.slice(-5); // last 5 actions
    context += `\n\nLịch sử hành động gần đây (${recent.length} bước cuối):`;
    recent.forEach((h, i) => {
      context += `\n${i + 1}. ${h.action} → "${h.target || ''}" ${h.success ? '✓' : '✗ ' + (h.error || '')}`;
    });
    context += `\n\nQUAN TRỌNG: Nếu bạn đã thử đăng nhập và thấy lỗi hoặc form đăng nhập vẫn hiện → thông tin đăng nhập SAI. Dùng "ask_user" để hỏi người dùng cung cấp thông tin đăng nhập đúng. KHÔNG thử lại cùng credentials.`;
  }

  if (userInstructions) {
    context += `\n\n⚠️ HƯỚNG DẪN TỪ NGƯỜI DÙNG (ưu tiên cao nhất):\n${userInstructions}`;
  }

  return context;
};

class BrowserAgent {
  constructor() {
    this.browser = null;
    this.page = null;
    this.running = false;
    this.listeners = [];
    this.maxSteps = 50;
    // User interaction
    this.userMessages = [];
    this.waitingForUser = false;
    this.userResolve = null;
  }

  // ── SSE listeners ──────────────────────────────────────────────

  addListener(res) {
    this.listeners.push(res);
  }

  removeListener(res) {
    this.listeners = this.listeners.filter(l => l !== res);
  }

  emit(event, data) {
    const payload = `data: ${JSON.stringify({ event, ...data })}\n\n`;
    console.log(`[BrowserAgent] emit: ${event} → ${data.status || data.question || ''} (listeners: ${this.listeners.length})`);
    this.listeners.forEach(res => {
      try { res.write(payload); } catch (e) {
        console.error('[BrowserAgent] SSE write failed:', e.message);
      }
    });
  }

  // ── User instruction injection ─────────────────────────────────

  injectMessage(text) {
    this.userMessages.push(text);
    this.emit('status', { status: `📝 Đã nhận hướng dẫn: "${text}"` });

    // Try to extract new credentials from user message
    this.parseCredentials(text);

    // If agent is paused waiting for user, unpause it
    if (this.waitingForUser && this.userResolve) {
      this.waitingForUser = false;
      this.userResolve();
      this.userResolve = null;
    }
  }

  parseCredentials(text) {
    if (!this.credentials) return;

    const clean = (s) => s.replace(/[,.\s]+$/, '').trim();

    // Match patterns like: tài khoản là X, username là X, tk: X, tk X
    const userMatch = text.match(/(?:tài khoản|tai khoan|username|user|tk|tên đăng nhập|ten dang nhap)\s*(?:là|la|:|=)?\s*(\S+)/i);
    if (userMatch) {
      const val = clean(userMatch[1]);
      if (val && val.length > 0) {
        this.credentials.username = val;
        this.emit('status', { status: `Đã cập nhật tài khoản: ${val}` });
        console.log('[BrowserAgent] Updated username to:', val);
      }
    }

    // Match patterns like: mật khẩu là X, password là X, mk: X, pass X
    const passMatch = text.match(/(?:mật khẩu|mat khau|password|pass|mk)\s*(?:là|la|:|=)?\s*(\S+)/i);
    if (passMatch) {
      const val = clean(passMatch[1]);
      if (val && val.length > 0) {
        this.credentials.password = val;
        this.emit('status', { status: `Đã cập nhật mật khẩu.` });
        console.log('[BrowserAgent] Updated password to:', val);
      }
    }
  }

  waitForUser(question, timeoutMs = 60000) {
    this.waitingForUser = true;
    this.emit('ask_user', { status: question, question });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waitingForUser) {
          this.waitingForUser = false;
          this.userResolve = null;
          resolve(false); // timed out
        }
      }, timeoutMs);

      this.userResolve = () => {
        clearTimeout(timer);
        resolve(true); // user responded
      };
    });
  }

  // ── Browser interaction ────────────────────────────────────────

  async takeScreenshot() {
    if (!this.page) throw new Error('No page');
    const buffer = await this.page.screenshot({ fullPage: false, type: 'jpeg', quality: 70 });
    return buffer.toString('base64');
  }

  async askAI(screenshotBase64, phase, invoiceData, credentials, userInstructions = '', actionHistory = []) {
    const client = getClient();
    const currentUrl = this.page ? this.page.url() : 'unknown';

    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(phase, invoiceData, credentials, currentUrl, userInstructions, actionHistory) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}`, detail: 'high' } }
          ]
        }
      ]
    });

    const raw = completion?.choices?.[0]?.message?.content ?? '';
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('AI did not return JSON');
    return JSON.parse(raw.slice(start, end + 1));
  }

  async executeAction(action) {
    const { action: type, target, value } = action;

    switch (type) {
      case 'click': {
        let el = this.page.getByRole('button', { name: new RegExp(target, 'i') });
        if (await el.count() === 0) el = this.page.getByRole('link', { name: new RegExp(target, 'i') });
        if (await el.count() === 0) el = this.page.getByText(target, { exact: false });
        if (await el.count() === 0) el = this.page.locator(`[placeholder*="${target}" i], [aria-label*="${target}" i], [title*="${target}" i]`);

        if (await el.count() > 0) {
          await el.first().click({ timeout: 5000 });
        } else {
          throw new Error(`Could not find element: ${target}`);
        }
        break;
      }

      case 'type': {
        let el = this.page.getByPlaceholder(target);
        if (await el.count() === 0) el = this.page.getByLabel(target);
        if (await el.count() === 0) el = this.page.locator(`input[name*="${target}" i], textarea[name*="${target}" i]`);
        if (await el.count() === 0) el = this.page.getByRole('textbox', { name: new RegExp(target, 'i') });

        if (await el.count() > 0) {
          await el.first().click({ timeout: 5000 });
          await el.first().fill(value || '');
        } else {
          throw new Error(`Could not find input: ${target}`);
        }
        break;
      }

      case 'select': {
        let el = this.page.getByLabel(target);
        if (await el.count() === 0) el = this.page.locator(`select[name*="${target}" i]`);

        if (await el.count() > 0) {
          await el.first().selectOption({ label: value });
        } else {
          throw new Error(`Could not find select: ${target}`);
        }
        break;
      }

      case 'scroll':
        await this.page.mouse.wheel(0, 400);
        break;

      case 'wait':
        await this.page.waitForTimeout(2000);
        break;

      case 'done':
      case 'error':
      case 'ask_user':
        return type;

      default:
        throw new Error(`Unknown action: ${type}`);
    }

    await this.page.waitForTimeout(1000);
    return 'continue';
  }

  // ── Main automation loop ───────────────────────────────────────

  async run({ websiteUrl, credentials, invoiceData }) {
    if (this.running) throw new Error('Agent is already running');
    this.running = true;
    this.credentials = { ...credentials }; // mutable copy so user can update

    try {
      this.emit('status', { status: 'Đang mở trình duyệt...' });

      this.browser = await chromium.launch({ headless: false });
      const context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
      this.page = await context.newPage();

      const url = websiteUrl.match(/^https?:\/\//) ? websiteUrl : `https://${websiteUrl}`;

      this.emit('status', { status: `Đang truy cập ${url}...` });
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(2000);

      let phase = 'login';
      let step = 0;
      let consecutiveErrors = 0;
      const actionHistory = []; // track what was tried
      let loginAttempts = 0;

      while (step < this.maxSteps && this.running) {
        step++;

        // Drain any queued user messages
        const userInstructions = this.userMessages.splice(0).join('\n');

        // If user provided new instructions, reset login attempts (they may have given new credentials)
        if (userInstructions && phase === 'login') {
          loginAttempts = 0;
        }

        this.emit('status', { status: `Bước ${step}: Đang phân tích trang (${phase})...`, phase, step });

        let screenshot;
        try {
          screenshot = await this.takeScreenshot();
        } catch (err) {
          this.emit('error', { status: `Không thể chụp màn hình: ${err.message}` });
          break;
        }

        let action;
        try {
          action = await this.askAI(screenshot, phase, invoiceData, this.credentials, userInstructions, actionHistory);
        } catch (err) {
          this.emit('error', { status: `Lỗi AI: ${err.message}`, step });
          const responded = await this.waitForUser(`Gặp lỗi khi phân tích: ${err.message}. Bạn có muốn thử lại không?`);
          if (responded && this.running) { consecutiveErrors = 0; continue; }
          break;
        }

        this.emit('action', { status: action.status || action.reasoning, action: action.action, target: action.target, step });

        // ── Handle terminal / interactive actions ──

        if (action.action === 'done') {
          this.emit('done', { status: 'Hoàn thành! Đã điền xong hóa đơn.', step });
          break;
        }

        if (action.action === 'ask_user') {
          const question = action.question || action.reasoning || 'Tôi cần hướng dẫn từ bạn để tiếp tục.';
          actionHistory.push({ action: 'ask_user', target: question, success: true });
          const responded = await this.waitForUser(question);
          if (responded && this.running) { consecutiveErrors = 0; continue; }
          this.emit('error', { status: 'Không nhận được phản hồi. Dừng tự động hóa.', step });
          break;
        }

        if (action.action === 'error') {
          consecutiveErrors++;
          const errorMsg = action.reasoning || 'Gặp lỗi không xác định.';
          actionHistory.push({ action: 'error', target: errorMsg, success: false, error: errorMsg });
          const responded = await this.waitForUser(`Gặp vấn đề: ${errorMsg}. Bạn muốn tôi làm gì tiếp?`);
          if (responded && this.running) { consecutiveErrors = 0; continue; }
          this.emit('error', { status: `Dừng do lỗi: ${errorMsg}`, step });
          break;
        }

        // Track login button clicks
        if (phase === 'login' && action.action === 'click') {
          const t = (action.target || '').toLowerCase();
          if (t.includes('login') || t.includes('đăng nhập') || t.includes('sign in') || t.includes('submit')) {
            loginAttempts++;
          }
        }

        try {
          await this.executeAction(action);
          consecutiveErrors = 0;
          actionHistory.push({ action: action.action, target: action.target, value: action.value, success: true });
        } catch (err) {
          consecutiveErrors++;
          actionHistory.push({ action: action.action, target: action.target, success: false, error: err.message });
          this.emit('error', { status: `Không thể thực hiện: ${err.message}`, step });
          if (consecutiveErrors >= 3) {
            const responded = await this.waitForUser(`Gặp lỗi liên tục khi thực hiện hành động. Bạn có gợi ý gì không?`);
            if (responded && this.running) { consecutiveErrors = 0; continue; }
            break;
          }
          continue;
        }

        // ── Phase transitions based on actual page state ──
        const currentUrl = this.page.url();

        if (phase === 'login') {
          // Detect login failure: still on login page after clicking login button
          if (loginAttempts >= 2) {
            // Tried logging in twice and still here — credentials are wrong
            this.emit('error', { status: 'Đăng nhập thất bại. Có thể sai tài khoản hoặc mật khẩu.', step });
            const responded = await this.waitForUser('Đăng nhập không thành công. Vui lòng cung cấp tài khoản và mật khẩu đúng. Ví dụ: "tài khoản là ABC mật khẩu là XYZ"');
            if (responded && this.running) {
              loginAttempts = 0;
              consecutiveErrors = 0;
              // Clear login action history so AI starts fresh
              actionHistory.length = 0;
              // Reload page to get clean login form
              this.emit('status', { status: 'Đang tải lại trang đăng nhập với thông tin mới...' });
              try {
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
                await this.page.waitForTimeout(2000);
              } catch {}
              continue;
            }
            break;
          }
          // Check if we actually left the login page
          if (!currentUrl.includes('login') && !currentUrl.includes('signin') && !currentUrl.includes('auth')) {
            phase = 'navigate';
            this.emit('status', { status: 'Đăng nhập thành công! Đang tìm trang tạo hóa đơn...', phase, step });
          }
        } else if (phase === 'navigate') {
          // Check if URL suggests we found an invoice page
          if (currentUrl.includes('invoice') || currentUrl.includes('create') || currentUrl.includes('new') || currentUrl.includes('hoadon')) {
            phase = 'fill';
            this.emit('status', { status: 'Đã tìm thấy form hóa đơn! Đang điền thông tin...', phase, step });
          }
        }
      }

      if (step >= this.maxSteps) {
        this.emit('error', { status: 'Đã vượt quá số bước tối đa. Dừng tự động hóa.', step });
      }

    } catch (err) {
      console.error('[BrowserAgent] Unhandled error:', err.message);
      this.emit('error', { status: `Lỗi: ${err.message}` });
    } finally {
      console.log('[BrowserAgent] Loop ended. running:', this.running, 'listeners:', this.listeners.length);
      // Emit done signal so frontend knows automation ended
      this.emit('done', { status: 'Tự động hóa đã kết thúc.' });
      await this.cleanup();
    }
  }

  async stop() {
    this.running = false;
    await this.cleanup();
    this.emit('status', { status: 'Đã dừng tự động hóa.' });
  }

  async cleanup() {
    this.running = false;
    // Unblock any pending waitForUser
    if (this.userResolve) {
      this.userResolve();
      this.userResolve = null;
    }
    this.waitingForUser = false;
    this.userMessages = [];
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
      }
    } catch {}
  }
}

// Singleton instance
let agentInstance = null;

exports.getAgent = () => {
  if (!agentInstance) agentInstance = new BrowserAgent();
  return agentInstance;
};

exports.resetAgent = () => {
  if (agentInstance) agentInstance.cleanup();
  agentInstance = new BrowserAgent();
  return agentInstance;
};
