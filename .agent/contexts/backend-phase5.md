# BACKEND AGENT — PHASE 5 TASK BRIEF: AI INTEGRATION & REAL-TIME UPDATES

> **Read these files first:**
> - `.agent/shared/global-rules.md`
> - `.agent/roles/backend-agent.md`
> - `.agent/task.md`
> - `server/src/services/aiService.js`

---

## 1. OBJECTIVE
Transition from placeholders to a fully integrated **Voice-to-Automation** loop. You will implement the trigger for the Automation Engine and provide a real-time status update mechanism (using WebSockets or simple polling/SSE) so the frontend can track the AI's progress on `vinvoice.com`.

---

## 2. ARCHITECTURE & REQUIREMENTS
- **Automation Trigger:** Create a `POST /api/invoice/:id/automate` endpoint. This should fetch the invoice from MongoDB and start the `automationService.js` in the background (do not block the HTTP response).
- **Real-Time Status:** Implement a way for the Automation Service to "report back" its progress (e.g., "Logging in...", "Filling form...", "Success"). 
    - *Option A:* Store status in the Invoice document and have the frontend poll.
    - *Option B:* Simple Server-Sent Events (SSE) for the life of the automation task.
- **AI Vision Loop:** Enhance `aiService.js` to include a `visionAnalyzePage(screenshot, invoiceData)` method. This method sends the screenshot + invoice JSON to GPT-4o Vision to get back a specific Playwright action (click/type/finish).

---

## 3. STEP-BY-STEP EXECUTION
1. **Enhance AI Service:** Implement `visionAnalyzePage` in `src/services/aiService.js`. Use GPT-4o Vision to analyze the base64 screenshot.
2. **Update Automation Service:** Integrate `visionAnalyzePage` into the loop in `src/services/automationService.js`. Replace the placeholder logic with actual AI-driven Playwright commands.
3. **Status Tracking:** Add a `status` field to the `Invoice` schema (`idle`, `drafting`, `completed`, `failed`) and a `statusMessage` field for detailed AI logs.
4. **Trigger Endpoint:** Create the `POST /api/invoice/:id/automate` route in `src/routes/invoiceRoutes.js`.
5. **Security:** Ensure the `automationService` handles errors gracefully without crashing the server.

---

## 4. ACCEPTANCE CRITERIA
- `POST /api/invoice/:id/automate` starts the Chromium browser.
- The logs show the AI actually analyzing the screenshot (calling OpenAI).
- The Invoice status in MongoDB updates dynamically as the automation progresses.
