# FRONTEND AGENT — PHASE 5 TASK BRIEF: AUTOMATION PROGRESS & REFINEMENT

> **Read these files first:**
> - `.agent/shared/global-rules.md`
> - `.agent/roles/frontend-agent.md`
> - `.agent/task.md`

---

## 1. OBJECTIVE
Implement the "Automation Trigger" and "Progress Tracker" UI. The user needs to see what the AI is doing on `vinvoice.com` in real-time after they confirm the invoice data.

---

## 2. ARCHITECTURE & REQUIREMENTS
- **Draft Trigger:** Add a "Draft on Website" button to the `InvoiceFormComponent`.
- **Progress Tracking:** When the automation starts, show a "Live Progress" overlay or sidebar. This should poll the backend (or use SSE) to show the `statusMessage` from the Invoice document.
- **Visual Feedback:** Use a terminal-like log view or a step-by-step progress bar (1. Navigating, 2. Analyzing, 3. Filling, 4. Done).
- **Voice UI Refinement:** Add a simple CSS audio visualizer or "pulsing" animation while the `MediaRecorder` is active to improve user experience.

---

## 3. STEP-BY-STEP EXECUTION
1. **API Service:** Add `automateInvoice(id)` method to `api.service.ts`.
2. **Invoice Form Update:** Add the "Draft on Website" button. Disable it if the form is invalid or automation is already running.
3. **Progress Component:** Create `AutomationProgressComponent` to display the real-time logs/status from the backend.
4. **Polling Logic:** Use an RxJS `interval` to poll `GET /api/invoice/:id` every 2 seconds while the status is `drafting`.
5. **Animation:** Update `VoiceInterfaceComponent` with a CSS-based recording animation.

---

## 4. ACCEPTANCE CRITERIA
- Clicking "Draft on Website" triggers the backend process.
- The UI shows "Drafting..." state and displays updates from the AI (e.g., "AI is analyzing the page structure").
- The button is disabled while the process is active.
