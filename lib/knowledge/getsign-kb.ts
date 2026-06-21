/**
 * Local GetSign knowledge base, sourced from the official site (getsign.io).
 *
 * Every entry's `body` is drawn from real product pages — no invented steps.
 * This corpus is merged into search_knowledge_base alongside the live Freshdesk
 * Solutions KB so Jetta can ground product answers and cite getsign.io URLs.
 *
 * Maintenance: re-fetch the source pages when the product changes. Last sourced
 * 2026-06-20.
 */
import { GETSIGN_GENERATED } from "./getsign-generated";

export interface KbArticle {
  title: string;
  url: string;
  /** Plain-text article body Jetta grounds answers in. */
  body: string;
  /** Extra search terms beyond the title/body words. */
  keywords?: string[];
  /** Where this came from, for transparency. */
  source: "getsign.io" | "freshdesk";
}

const CURATED: KbArticle[] = [
  {
    title: "eSignature — sending documents for signature",
    url: "https://getsign.io/feature/esignature/",
    keywords: ["sign", "signature", "send", "recipient", "signer", "esign", "email", "link"],
    source: "getsign.io",
    body: `GetSign is a native eSignature platform inside monday.com — send signature requests and monitor progress without leaving your boards. Signing workflow: (1) Upload or select a template; (2) Auto-fill using board data by mapping monday.com columns to document placeholders; (3) Add recipients and signing order; (4) Send via email or a secure link — recipients receive personalized signing links and can sign from any device without logging in; (5) Track status (who signed, when, what is pending) within monday.com. Supports batch sending (one document to many recipients), customizable branded emails, optional OTP verification, real-time tracking, and automatic reminders to unsigned recipients. Security: AES-256 encryption at rest, TLS 1.2 in transit, time-stamped logs of every signature action; GDPR and HIPAA compliant; legally binding with full audit trails.`,
  },
  {
    title: "Document Generation — templates, fields, and field mapping",
    url: "https://getsign.io/feature/document-generation/",
    keywords: ["generate", "document", "template", "docx", "pdf", "field", "dropdown", "checkbox", "date", "map", "column", "placeholder", "table", "subitem"],
    source: "getsign.io",
    body: `GetSign generates documents from monday.com board data. Workflow: (1) Upload existing Word (.docx) or PDF files into the Template Gallery; (2) In the template editor, highlight dynamic fields (e.g. client name, project title, deal value) and map them to board columns; (3) Documents generate automatically on triggers such as status changes or button clicks; (4) Generated documents attach to the monday.com item's File Column. Smart fields available in templates include text inputs, dropdowns, checkboxes, and date pickers. It maps board items and subitems into documents, pulls live column data, and supports inserting tables with multiple rows. Supports batch generation across rows, automatic sending via automation rules, OTP verification, real-time tracking, and reminders. Setup requires mapping columns manually in the template editor.`,
  },
  {
    title: "Template Gallery — adding fields (dropdowns, checkboxes, signatures)",
    url: "https://getsign.io/capabilities/template-gallery/",
    keywords: ["template", "gallery", "dropdown", "checkbox", "date", "line item", "signature box", "field", "placeholder", "map", "column", "options", "fillable"],
    source: "getsign.io",
    body: `The Template Gallery holds reusable .docx and PDF templates that auto-populate with live monday.com data. Upload a template once, then map board columns to document placeholders; the template becomes available across the whole board. Field mapping connects monday.com board columns — including text, numbers, dates, dropdowns, and subitems — directly to template placeholders. Beyond basic text mapping, you can add interactive elements in the template editor: eSignature boxes, checkboxes, date fields, dropdown selections, and line items. Workflow: select board items → upload/create template → map board fields to placeholders → customize with signature and form fields → generate and send with real-time tracking.`,
  },
  {
    title: "Web Forms — fillable forms that update board columns",
    url: "https://getsign.io/feature/web-forms/",
    keywords: ["form", "web form", "fillable", "field", "response", "collect", "submission", "embed", "workflow"],
    source: "getsign.io",
    body: `GetSign Web Forms builds fillable, branded forms inside monday.com that capture responses and trigger workflows. Build native forms without leaving boards, convert existing board columns into fillable fields, use reusable templates, and share via secure links or website embed. Responses map to and update board columns instantly and populate new rows. On submission, forms can trigger actions: auto-create items/tickets, update statuses, generate documents, start eSignature flows, launch monday.com automations, or assign teammates. Setup: (1) upload or select a template; (2) auto-fill using board data (map fields from columns); (3) optional configuration — permissions, passwords, expiration dates, submission controls; (4) share via link; (5) collect responses and trigger actions. No code required.`,
  },
  {
    title: "Signing Order — sequential signing",
    url: "https://getsign.io/capabilities/set-signing-order/",
    keywords: ["signing order", "sequence", "order", "sequential", "parallel", "first", "next", "recipients"],
    source: "getsign.io",
    body: `Signing Order defines the sequence in which recipients must sign. Signing is sequential: each signer is notified only after the previous one completes, and later signers cannot access the document until their turn. Setup: (1) connect GetSign to your monday.com workspace; (2) upload or select a template; (3) assign signer roles/positions in the document editor by dragging signature fields in order; (4) specify each position's email; (5) save; (6) track progress from the board. Sequences can differ per document/board, with real-time tracking, audit logs, and automatic notifications to the next signer. The signing order cannot be modified after a document is sent. (Per the FAQ, you can alternatively have all signers sign in parallel instead of setting an order.)`,
  },
  {
    title: "OTP Authentication — verify signers before access",
    url: "https://getsign.io/capabilities/otp-authentication/",
    keywords: ["otp", "one-time password", "passcode", "verify", "verification", "security", "code", "authentication"],
    source: "getsign.io",
    body: `OTP (One-Time Password) verification adds a security layer: the signer receives a time-sensitive code by email and must enter it before accessing the document. Enable it per-document by toggling the OTP option when preparing the document. The signer receives an email saying an OTP-protected document is waiting, opens the link, and enters the code to unlock it — no account or app needed. OTP is part of standard GetSign capabilities at no additional cost, and supports GDPR/HIPAA compliance. Common uses: NDAs, employment contracts, vendor agreements, payment authorizations, high-value contracts.`,
  },
  {
    title: "Document Signing Links — shareable, no-login signing",
    url: "https://getsign.io/capabilities/document-signing-link/",
    keywords: ["link", "signing link", "share", "url", "external", "revoke", "expire", "public"],
    source: "getsign.io",
    body: `Document signing links are secure, shareable URLs for any document — good for public forms, external signers, or mass outreach. Recipients sign instantly with no account or login. Each link is unique and secure; you control its lifecycle and can revoke access at any time. One document can go to multiple signers via individual links, each tracked separately. Share via email, messaging, embedded forms, or websites. Real-time board updates show who signed, timestamps, and pending status. Links stay active until explicitly disabled. Handles high volume (100+ acknowledgments at once). Included at no extra cost if your plan includes GetSign capabilities.`,
  },
  {
    title: "Payment Collection — sign and pay via Stripe",
    url: "https://getsign.io/feature/payment-collection/",
    keywords: ["payment", "pay", "stripe", "charge", "invoice", "deposit", "currency"],
    source: "getsign.io",
    body: `GetSign collects payments within monday.com workflows via Stripe (the only supported processor). When a form is submitted or a board item triggers a workflow, GetSign emails a personalized Stripe payment link; recipients can sign and pay in one session. Setup: (1) select a board item requiring payment; (2) connect a Stripe account in GetSign settings; (3) assign a status column/label (e.g. "Payment Required"); (4) define amount and currency; (5) send for signing and payment. Amounts can be dynamic from board columns. Real-time payment status on the board; post-payment automation (invoice generation, marking items, notifications). PCI-DSS Level 1 compliant; GetSign does not store card data.`,
  },
  {
    title: "Legally Binding & Compliance",
    url: "https://getsign.io/capabilities/legally-binding/",
    keywords: ["legal", "legally binding", "compliance", "esign", "eidas", "gdpr", "hipaa", "ueta", "audit", "audit trail", "security", "encryption"],
    source: "getsign.io",
    body: `GetSign signatures are legally binding by default, with no third-party software or extra fees. Enforceability comes from: intent (every signer reviews and confirms before completing), time-stamped audit logs of all signing events, optional OTP identity verification, tamper-proof storage, and cryptographic digital certificates (authenticity and non-repudiation). Compliance: GDPR, HIPAA, eIDAS (EU), ESIGN Act (US), and UETA. Audit trail records views, clicks, and completion events with timestamps, stored within monday.com's infrastructure with document-level integrity verification.`,
  },
  {
    title: "GetSign FAQ",
    url: "https://getsign.io/",
    keywords: ["faq", "multiple signers", "parallel", "approvals", "automate", "form", "document management"],
    source: "getsign.io",
    body: `Multiple signers: GetSign can send one document to multiple signers; choose whether all sign in parallel or set a specific signing order. Document generation: create contracts, proposals, agreements, or HR letters from board data — build templates, auto-fill details, and generate instantly. Approvals/automation: set up workflows where documents are auto-generated from board data and routed for approval with predefined rules. Forms: turn any board into a form; responses auto-populate the board and can trigger document generation or signature requests. Document management: documents can be generated, stored, tracked, and moved across workflows automatically, with secure storage and audit trails.`,
  },
  {
    title: "GetSign Release Notes (recent)",
    url: "https://getsign.io/releases/",
    keywords: ["release", "changelog", "update", "new", "fix", "version", "reminder", "mirror", "connect board", "lookup", "sign anywhere", "images"],
    source: "getsign.io",
    body: `Recent GetSign releases: (2026-06-19) Automatic reminder emails for signers with customizable intervals and frequency, across new and existing setups. (2026-06-18) Document Templates can now display multiple images from one File column with grid layout (rows, columns, image count). (2026-05-19) Smart confirmation prompts distinguish global template edits (via Template Gallery) from item-specific document changes. (2026-05-14) "Sign Anywhere" now supports multiple signers with automatic status tracking. (2026-05-13) Support for monday.com Connect Boards and Mirror Columns to pull dynamic data from multiple boards for automated invoice and contract generation.`,
  },

  // ── Step-by-step how-to guides (getsign.io/getting-started + /how-tos) ──
  {
    title: "How to send a document for eSignature (step by step)",
    url: "https://getsign.io/getting-started/how-to-send-documents-for-esignature-in-monday/",
    keywords: ["send", "esignature", "sign", "how to send", "signature field", "verify email", "recipient", "status column", "file column"],
    source: "getsign.io",
    body: `Steps to send a document for signature: (1) Install the GetSign Item View from the monday.com marketplace and add GetSign as an item view on the item; (2) In Templates and Documents, upload the base document — DOCX (recommended) or PDF — or use a document already in a file column; (3) Enable Signature Collection and select a Status Column (tracks progress) and a File Column (stores the signed document); (4) In the Send Configuration tab, enter the sender email, verify it via the link sent to your inbox, optionally customize the subject, and save; (5) Click Edit Template to open the editor and drag in signature fields for each signer, date fields (auto timestamps), and text fields, assigning each to a role/name, then save; (6) Click Send — signers receive email invitations, the Status Column updates as signatures complete, and the final signed document is stored in the File Column.`,
  },
  {
    title: "How to set up or modify a multi-step signing order (step by step)",
    url: "https://getsign.io/getting-started/create-or-modify-signing-order/",
    keywords: ["signing order", "multi-step", "sequence", "order", "signer", "rearrange", "reconfigure", "popup", "pop-up blocked"],
    source: "getsign.io",
    body: `Set up a signing order: (1) Open the item view, launch GetSign, click Upload Template and select your file — the editor opens to insert signature fields per signer. If pop-ups are blocked, go to the template gallery after upload and click Edit. (2) Click a signature field, enable "Signing Order Required", and drag-and-drop to arrange signers top-to-bottom (first signer at top); save and close. (3) Configure the Status column as a trigger and set email delivery (subject, logo, recipients); send via Share > Send or by updating the status. The document goes to the first signer, then routes sequentially to each next signer only after the previous one signs; once all sign, the signed document is stored in the file column and emailed to all participants (if enabled). To add/remove a signer: Edit Template, add/assign a signature field, save — IMPORTANT: every time you update the template you must reconfigure the signing order.`,
  },
  {
    title: "How to create fillable forms and collect data (step by step)",
    url: "https://getsign.io/getting-started/create-fillable-forms-on-monday/",
    keywords: ["form", "fillable", "field", "required", "mandatory", "map", "column", "drag", "text field", "signature field", "collect data"],
    source: "getsign.io",
    body: `Create a fillable form: (1) Prepare a board with an item per recipient and text columns for the data to collect; (2) In the GetSign item view click Add Template and upload a DOCX form with section headers where fields go — the editor launches; (3) Drag elements into the editor (board fields like Item Name/Email, and text fields for open responses), link each field to a board column (you can create new columns from the editor), mark fields as required where needed, and include a signature field (mandatory for sending); (4) Click Save Template and close; (5) In Signature Collection settings choose a status column (progress) and a file column (stores completed forms), customize subject/logo, and verify the sender email if prompted; (6) Send via Share > Send or by updating the status column; (7) Recipients get an email link, complete the form, and responses auto-populate board columns with the signed document attached.`,
  },
  {
    title: "How to generate documents from board data (step by step)",
    url: "https://getsign.io/getting-started/generate-documents-from-monday-com/",
    keywords: ["generate", "document", "template", "map", "field", "dropdown", "placeholder", "trigger", "status", "preview", "subitem", "currency"],
    source: "getsign.io",
    body: `Generate a document from board data: (1) Install GetSign from the marketplace and add it to the item view; (2) In Templates and Documents, upload a DOCX (recommended) or PDF with placeholders for the data (client names, dates, line items, totals); (3) In the Generate section, select a Status Column as the automation trigger, choose the trigger value (e.g. "Ready"), pick the File Column for output, and select output format (DOCX or PDF); (4) Click Edit Template and insert dynamic fields from your board — Item Name, date columns, text or dropdown fields, price/number fields — use the sub-items option to insert subitems, apply AND/OR filtering, and set currency format/placement; (5) Use Preview to test, then Save Template; (6) Change the item's status to the trigger value and GetSign generates the document from current board values into the file column within seconds. Note: dropdown fields are inserted as dynamic fields mapped from a monday.com dropdown column.`,
  },
  {
    title: "How to generate documents from Connect Board / Mirror column data (step by step)",
    url: "https://getsign.io/how-tos/generate-documents-from-connect-board-data-on-monday-com/",
    keywords: ["connect board", "mirror", "mirror column", "lookup", "vlookup", "linked", "not pulling", "formula", "dynamic table", "multiple boards"],
    source: "getsign.io",
    body: `Pull data from another board into a generated document using Connect Boards + Mirror columns: (1) In the GetSign item view, upload a DOCX template; (2) On your main board, add a Connect Boards column and connect the board that holds the data; (3) For each data point, add a Mirror column referencing the connected board's column (e.g. Quantity, Price); use Formula columns on the connected board for calculated values, then mirror them; rename mirror columns clearly; (4) IMPORTANT: link items in the Connect Boards column cell FIRST — the editor pulls data from already-linked items, which auto-populates the mirror columns; (5) In the GetSign editor click Edit Template → Connect Board; the Configure Board Items menu shows the linked items — verify mirrored columns with Table Preview; (6) Save to insert the dynamic table; (7) Save Template, Save and Exit; (8) In Settings, turn on Generate, pick a Status column + trigger value (e.g. "Approved"), a File column, and format. Common cause of mirror fields not pulling through: items not linked in the Connect Boards column before configuring, or the needed mirror/formula column not added.`,
  },
  {
    title: "How to set up automatic signature reminders (step by step)",
    url: "https://getsign.io/how-tos/send-automatic-signature-reminders-with-getsign/",
    keywords: ["reminder", "automatic reminder", "follow up", "interval", "hours", "nudge", "unsigned"],
    source: "getsign.io",
    body: `Set up automatic reminder emails to signers: (1) Open the GetSign item view and create or edit a setup; (2) Scroll to the Send Email Delivery section and find "Send Automatic Reminder to Recipients"; (3) Toggle it on (off prevents any reminders); (4) Configure intervals — defaults are 24 and 48 hours; remove an interval with the X, add a custom one by entering hours and clicking Add; multiple intervals can run simultaneously (e.g. 24, 72, 100 hours); (5) Click Save. Reminders then send automatically at the set intervals for every document on every board item in that setup. Applies to both new and existing GetSign configurations.`,
  },
  {
    title: "How to change page setup (size, orientation, margins) in the DOCX editor",
    url: "https://getsign.io/how-tos/change-page-setup-in-getsign-docx-editor/",
    keywords: ["page setup", "margins", "orientation", "portrait", "landscape", "a4", "letter", "page size", "docx", "formatting"],
    source: "getsign.io",
    body: `Change page setup in the GetSign DOCX editor: (1) Open the Page Setup menu in the editor; (2) Select page size (e.g. Letter or A4); (3) Choose orientation — Portrait or Landscape; (4) Configure margins using a preset (Normal, Wide, Narrow) or enter custom top/bottom/left/right measurements; (5) Click Apply — the preview updates immediately. Tip: preview before finalizing; final printed output also depends on printer settings.`,
  },
  {
    title: "How to collect signatures from multiple signers with 'Sign Anywhere'",
    url: "https://getsign.io/how-tos/streamline-multi-signer-document-collection-with-sign-anywhere/",
    keywords: ["sign anywhere", "multiple signers", "stored documents", "file column", "email column", "multi-signer", "existing document"],
    source: "getsign.io",
    body: `'Sign Anywhere' sends existing documents (from File columns, not templates) to multiple signers. (1) In GetSign settings, toggle on "Use Stored Documents" and select the File column holding the unsigned documents; (2) Enable Signature Collection, pick a board + Status column and a status value (e.g. "Sent for Signatures"), choose a destination File column for signed docs, toggle on "Sign Anywhere", select an Email column for each signer, and enter sender name/reply-to; Save; (3) Send via the item's Shared section > Send, or by changing the Status column to your configured value. Notes: works only with documents in File columns (not templates); use separate Email columns when signer addresses differ per item; upload the correct unsigned document to the source File column before sending.`,
  },
  {
    title: "GetSign supported workflows & document use cases (690+ templates)",
    url: "https://getsign.io/workflow/",
    keywords: [
      "workflow", "use case", "template", "automate", "can getsign", "does getsign support",
      "agreement", "contract", "nda", "purchase agreement", "rental agreement", "lease", "sow", "statement of work",
      "approval", "acknowledgement", "policy", "authorization", "consent", "checklist", "letter", "offer letter",
      "certificate", "report", "request", "payment", "invoice", "quote", "notice", "termination",
      "hr", "onboarding", "vendor", "supplier", "contractor", "compliance", "legal", "finance", "procurement",
      "background check", "certificate of insurance", "change order", "renewal", "application",
    ],
    source: "getsign.io",
    body: `GetSign offers 690+ pre-built, ready-to-use workflow templates on monday.com — so it can automate essentially any document-driven process. If a customer asks "can GetSign automate <some document/process>?", the answer is almost always yes when it involves generating, sending, signing, or tracking a document from monday.com board data.

Major workflow categories (with example use cases):
- Agreements & contracts (190+): NDAs, asset/stock purchase agreements, rental/lease, retainer, advisory board, construction, listing, SOWs.
- Approvals (60+): approval memos, board resolutions, ad/creative approval, drawing approval, billable-hours approval.
- Acknowledgements & policies (80+): acceptable-use, AI-usage, anti-harassment, BYOD, brand-standards, privacy-notice acknowledgements.
- Authorizations & consents: background check, bank statement, payment, travel, document-send authorizations.
- Requests & change orders: advance-payment, billing-change, scope-change, change-order, inspection requests.
- Certificates & reports: certificate of insurance/analysis/conformity/origin, closing certificates, incident/audit/deviation reports.
- Letters & notices: offer/rejection/transfer letters, letters of intent, termination/privacy notices, collections.
- Checklists: onboarding, access, contractor-compliance, inspection, competency checklists.
- Payments, quotes & invoices: payment plans, deposits, quotes, invoices (with Stripe collection).

Every workflow follows the same pattern: (1) upload a DOCX/PDF template; (2) map monday.com board columns to the document once (reused forever); (3) trigger via a status change, button click, or form submission; (4) collect signatures (single, multi-signer, or signing order); (5) track status in real time on the board; (6) store the signed file with an audit trail. Browse the full gallery at https://getsign.io/workflow/. These templates are compliant with ESIGN, eIDAS, UETA, GDPR, and HIPAA.`,
  },
];

/** Full corpus: curated feature/capability summaries + generated how-to guides. */
export const GETSIGN_KB: KbArticle[] = [...CURATED, ...GETSIGN_GENERATED];

/**
 * Lightweight keyword search over the local corpus. Scores each article by
 * weighted term matches (title > keywords > body) and returns the top matches.
 */
export function searchGetSignKb(query: string, limit = 3): KbArticle[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];

  const scored = GETSIGN_KB.map((a) => {
    const title = a.title.toLowerCase();
    const kw = (a.keywords ?? []).join(" ").toLowerCase();
    const body = a.body.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 3;
      if (kw.includes(t)) score += 2;
      if (body.includes(t)) score += 1;
    }
    return { a, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((s) => s.a);
}
