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

Quy tắc:
- Luôn trả về JSON duy nhất, không markdown
- Phân tích kỹ ảnh chụp màn hình để xác định trạng thái trang
- Nếu thấy form đăng nhập, điền thông tin đăng nhập
- Nếu thấy trang chủ/dashboard, tìm nút hoặc link tạo hóa đơn mới
- Nếu thấy form hóa đơn, điền từng trường một
- Nếu thấy nút submit/gửi, nhấn nó

Trả về JSON với cấu trúc:
{
  "action": "click" | "type" | "select" | "scroll" | "wait" | "done" | "error",
  "target": "mô tả element bằng text/placeholder/label mà bạn thấy trên màn hình",
  "value": "giá trị cần nhập (cho action type/select)",
  "reasoning": "giải thích ngắn gọn bằng tiếng Việt tại sao chọn hành động này",
  "status": "mô tả ngắn gọn trạng thái hiện tại bằng tiếng Việt"
}

Khi action là "done": có nghĩa là đã hoàn thành việc điền hóa đơn.
Khi action là "error": có nghĩa là gặp lỗi không thể tiếp tục.
`.trim();

const buildPrompt = (phase, invoiceData, credentials, currentUrl) => {
  let context = `URL hiện tại: ${currentUrl}\n`;

  if (phase === 'login') {
    context += `\nGiai đoạn: ĐĂNG NHẬP
Tên đăng nhập: ${credentials.username}
Mật khẩu: ${credentials.password}
Hãy tìm form đăng nhập và điền thông tin.`;
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

  return context;
};

class BrowserAgent {
  constructor() {
    this.browser = null;
    this.page = null;
    this.running = false;
    this.listeners = [];    // SSE listeners
    this.maxSteps = 30;
  }

  addListener(res) {
    this.listeners.push(res);
  }

  removeListener(res) {
    this.listeners = this.listeners.filter(l => l !== res);
  }

  emit(event, data) {
    const payload = `data: ${JSON.stringify({ event, ...data })}\n\n`;
    this.listeners.forEach(res => {
      try { res.write(payload); } catch {}
    });
  }

  async takeScreenshot() {
    if (!this.page) throw new Error('No page');
    const buffer = await this.page.screenshot({ fullPage: false, type: 'jpeg', quality: 70 });
    return buffer.toString('base64');
  }

  async askAI(screenshotBase64, phase, invoiceData, credentials) {
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
            { type: 'text', text: buildPrompt(phase, invoiceData, credentials, currentUrl) },
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
        // Try multiple strategies to find the element
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
        return type;

      default:
        throw new Error(`Unknown action: ${type}`);
    }

    await this.page.waitForTimeout(1000); // let page settle
    return 'continue';
  }

  async run({ websiteUrl, credentials, invoiceData }) {
    if (this.running) throw new Error('Agent is already running');
    this.running = true;

    try {
      this.emit('status', { status: 'Đang mở trình duyệt...' });

      // Launch Playwright Chromium — visible window via WSLg on WSL2
      this.browser = await chromium.launch({ headless: false });
      const context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
      this.page = await context.newPage();

      // Ensure URL has protocol
      const url = websiteUrl.match(/^https?:\/\//) ? websiteUrl : `https://${websiteUrl}`;

      // Phase 1: Navigate to website
      this.emit('status', { status: `Đang truy cập ${url}...` });
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(2000);

      // Phase 2: Login
      let phase = 'login';
      let step = 0;

      while (step < this.maxSteps && this.running) {
        step++;
        this.emit('status', { status: `Bước ${step}: Đang phân tích trang (${phase})...`, phase, step });

        const screenshot = await this.takeScreenshot();
        this.emit('screenshot', { screenshot, step });

        let action;
        try {
          action = await this.askAI(screenshot, phase, invoiceData, credentials);
        } catch (err) {
          this.emit('error', { status: `Lỗi AI: ${err.message}`, step });
          continue;
        }

        this.emit('action', { status: action.status || action.reasoning, action: action.action, target: action.target, step });

        if (action.action === 'done') {
          this.emit('done', { status: 'Hoàn thành! Đã điền xong hóa đơn.', step });
          break;
        }

        if (action.action === 'error') {
          this.emit('error', { status: `Lỗi: ${action.reasoning}`, step });
          break;
        }

        try {
          await this.executeAction(action);
        } catch (err) {
          this.emit('error', { status: `Không thể thực hiện: ${err.message}`, step });
          // Take new screenshot and retry with AI
          continue;
        }

        // Determine phase transitions
        const currentUrl = this.page.url();
        if (phase === 'login') {
          // After a few login steps, check if we moved past login
          if (step > 3 || !currentUrl.includes('login')) {
            phase = 'navigate';
            this.emit('status', { status: 'Đăng nhập thành công! Đang tìm trang tạo hóa đơn...', phase, step });
          }
        } else if (phase === 'navigate') {
          // After clicking a create invoice link, switch to fill
          if (step > 8 || currentUrl.includes('invoice') || currentUrl.includes('create') || currentUrl.includes('new')) {
            phase = 'fill';
            this.emit('status', { status: 'Đã tìm thấy form hóa đơn! Đang điền thông tin...', phase, step });
          }
        }
      }

      if (step >= this.maxSteps) {
        this.emit('error', { status: 'Đã vượt quá số bước tối đa. Dừng tự động hóa.', step });
      }

    } catch (err) {
      this.emit('error', { status: `Lỗi: ${err.message}` });
    } finally {
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
