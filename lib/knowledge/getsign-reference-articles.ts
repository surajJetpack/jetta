/**
 * The GetSign configuration reference, rewritten for customers.
 *
 * Source: the app team's reference, vendored in ./getsign-reference-doc.ts.
 * That doc is written for developers as much as for a chatbot (file paths,
 * component names, form field names, URL paths inside the app). These
 * articles keep only what a person sees on screen: labels, tabs, steps and
 * the rules behind them. Nothing here may name a file, a component, a field's
 * code name or an in-app URL path: scripts/getsign-reference-test.ts fails if
 * one does.
 *
 * `from` lists the reference sections an article was written from, each with
 * the fingerprint of that section at the time (see `sourceSections`). When
 * scripts/pull-getsign-reference.mjs brings in a changed section, the test
 * fails and names the article: reread the section, correct the article, and
 * update the fingerprint in the same pull request.
 *
 * lib/getsign-reference.ts files these as DRAFTS in the review queue. Nothing
 * is searchable until a person publishes it.
 */
export interface ReferenceArticle {
  id: string;
  title: string;
  keywords: string[];
  from: { section: string; hash: string }[];
  body: string;
}

export const GETSIGN_REFERENCE_ARTICLES: ReferenceArticle[] = [
  {
    id: "getsign-ref-how-getsign-is-organised",
    title: "How GetSign is organised: settings, workflows, templates and where to start",
    keywords: ["getsign", "dashboard", "workflow", "template gallery", "account settings", "start with", "proposal studio"],
    from: [
      { section: "Product mental model", hash: "57a338a1535c" },
      { section: "Route map (user-facing)", hash: "958cba6784d5" },
      { section: "Entry points & quick actions", hash: "3cf6fecf2e87" },
    ],
    body: `GetSign has three building blocks.

- **Account settings** hold the defaults for the whole account: email, security, custom domain, payments and account-wide approval rules.
- **A workflow** is the signing or document-generation setup for one board: which templates it uses, which monday columns it reads and writes, and any settings it overrides from the account defaults.
- **The template gallery** holds reusable document templates (PDF or DOCX). Template content is edited in the separate GetSign template editor, which opens from the gallery.

## Open GetSign from a board

Most of GetSign works in the context of a monday board. If the app is opened without a board, the workflow list and the send and generate screens show a message asking to open the app from a board instead of their usual content.

## Items or subitems

A workflow targets either items or subitems. This is chosen when the workflow is created and cannot be changed afterwards. It decides which rows appear when picking what to send or generate, and for a subitem workflow the column pickers show the subitem columns, not the parent board's.

## The screens

| Screen | What it is for |
| --- | --- |
| Home / Dashboard | The board's workflows, the quick actions, sessions and recent activity |
| Help | The tour, the FAQ and links into each flow |
| Account settings | Account-wide GetSign preferences |
| Workflows | Every workflow on the current board; open one to see its templates, send from it, rename, delete or edit its settings |
| Create workflow | A three-step wizard: Basics, Configure, Review |
| Create template | Upload a document; for a first-time user it continues into the full setup |
| Template gallery | Browse, create and manage templates |
| Send document | Pick a workflow and an item to send, or the first-time setup when the board has no workflow yet |
| Generate document | Generate a document from a workflow that has generation set up |
| Generate signing link | Create a signing link through Share & Track |

## Where to start

The dashboard's **Start With** card has four actions, in the order a new account needs them:

1. **Create Template**
2. **Create Workflow**
3. **Send Document**
4. **GetSign Generate**, which offers **Generate Document** or **Generate Link**

**Help → Take the 4-step tour** leads to the same four places.

## Proposal Studio and the products catalogue

Proposal Studio, "send proposal", "create proposal" and the products and services catalogue have been removed from GetSign, along with the in-app proposal editor. Anyone looking for them should use **Create Template**, **Create Workflow**, **Send Document** or **GetSign Generate** on the dashboard.`,
  },
  {
    id: "getsign-ref-account-settings",
    title: "GetSign account settings: what each tab controls",
    keywords: ["getsign", "account settings", "sender email", "sender name", "reminders", "custom domain", "otp", "watermark", "stripe", "approval rules", "time zone", "language", "brand logo"],
    from: [{ section: "Account settings", hash: "29734d70785f" }],
    body: `Account settings are the defaults for the whole GetSign account. Every workflow follows them unless that workflow overrides a section (see the workflow's General, Security and Approval Rules tabs).

## The tabs

| Tab | What is set there |
| --- | --- |
| **General** | Time zone, sender name and sender email, email subject and body, email language, brand logo, sending a copy of the signed document to the sender, and automatic reminders with their intervals |
| **Payments** | Connecting Stripe, needed for templates that have payment fields |
| **Custom Domain** | Verifying a domain through DNS, and the sender email once the domain is verified |
| **Security** | Requiring a one-time passcode (OTP) to sign, digital certification, and the watermark on signed files |
| **Approval Rules** | The account's default approval rules |

## How saving works

- General and Security are saved with the settings page's save button.
- Payments is a connect action of its own, not part of that save.
- Custom Domain saves its own steps as the domain is verified.
- Approval Rules has no save button for the page: rules are added, edited and removed one by one.

## General tab details

| Setting | Notes |
| --- | --- |
| Time zone | The account default for scheduling and for how times are shown |
| Sender name | Required |
| Sender email | Required. With a verified custom domain, the part after the @ may be fixed to that domain |
| Email subject | Can mix text with values from board columns |
| Email body | Has a maximum length |
| Language | English, French, Hebrew, Portuguese, Spanish or Japanese |
| Brand logo | May be locked on plans without branding |
| Send copy to sender | Sends the signed document to the sender as well |
| Auto reminders | On or off, with the reminder intervals in hours (for example 24 and 48) |

## Security tab details

- **Require OTP** asks the signer for a one-time passcode before signing.
- **Digital certification** certifies signed documents. Turning it off also turns off the watermark.
- **Watermark on signed files** is only available while digital certification is on.

## During first-time setup

The same tabs appear as step 2 of the Create Document setup, so a new account can set them without leaving the wizard.`,
  },
  {
    id: "getsign-ref-create-a-workflow",
    title: "Creating and editing a GetSign workflow",
    keywords: ["getsign", "create workflow", "edit workflow", "wizard", "collect signatures", "generate documents", "items", "subitems", "template", "target level"],
    from: [{ section: "Workflow creation & edit", hash: "eda5c2299c42" }],
    body: `A workflow is created with a three-step wizard. An existing workflow is changed through **Edit settings** on the workflow, which opens the Configure tabs only (no Basics or Review step).

| Step | What it covers |
| --- | --- |
| **1. Basics** | Name, what the workflow is for, its templates, and items or subitems |
| **2. Configure** | The settings tabs (up to seven, depending on what the workflow is for) |
| **3. Review** | A read-only summary; confirming creates the workflow |

## Step 1: Basics

| Field | Rules |
| --- | --- |
| Workflow name | Required |
| What the workflow is for | **Collect Signatures** or **Generate Documents**. A workflow started from Generate Link collects signatures through a signing link |
| Templates | At least one. Some plans allow only one template per workflow |
| Field mapping | Asked for when a template was built on a different board from the workflow's |
| Items or subitems | Cannot be changed after the workflow is created. A subitem workflow uses the subitem columns |

Only document templates can be attached. Old proposal-gallery templates are refused with an error.

## Where the wizard was opened from matters

- Opened from **Send Document**: the workflow is set to collect signatures, and after it is created the app continues to sending from it.
- Opened from **Generate Document**: the workflow is set to generate documents, Configure opens on the Generate tab, and after it is created the app returns to Generate Document with the new workflow selected.
- Opened from **Generate Link**: the workflow collects signatures with link tracking, Configure opens on Share & Track, and after it is created the app returns to Generate Link with the new workflow selected.

## Unfinished workflows

If the wizard is left before finishing, the name, templates, mappings, purpose and items-or-subitems choice are remembered for that board and restored the next time Create Workflow is opened. Starting from Send Document, Generate Document or Generate Link sets the purpose again to match where the wizard was opened from.`,
  },
  {
    id: "getsign-ref-workflow-settings-tabs",
    title: "GetSign workflow settings, tab by tab",
    keywords: ["getsign", "workflow settings", "configure", "signature collection", "sign anywhere", "use stored documents", "share & track", "getsign generate", "form filler", "approval rules", "override", "status column", "file column"],
    from: [{ section: "Workflow configure sections", hash: "70f3b1d7048f" }],
    body: `The Configure step of a workflow (and **Edit settings** on an existing one) is a set of tabs: General, Signature Collection, Share & Track, GetSign Generate, Security, Form Filler and Approval Rules.

## Which tabs appear

- A **Collect Signatures** workflow shows all seven. General and Signature Collection must be completed; Share & Track must be completed only if it is switched on. The other tabs are optional.
- A **Generate Documents** workflow shows the Generate tab only. This is by design: nothing else is needed to generate documents.
- A workflow created from **Generate Link** opens on Share & Track, which must be completed.

## Following the account or overriding it

General (email), Security and Approval Rules each follow the account settings by default. Switching a tab's override on shows that workflow's own fields; switching it back makes the workflow follow the account again. A change to account settings does not reach a workflow that overrides that section.

## General

Always shown on this tab:

| Setting | Rules |
| --- | --- |
| Status column that sends automatically | Optional. If a column is chosen, the status label is required too |
| Status label | The label that triggers the send |
| Use Stored Documents | Sends files already stored on the board. Turning it off while Sign Anywhere is on asks for confirmation and turns Sign Anywhere off |
| File column for the stored documents | Required when Use Stored Documents is on |

Shown when the workflow overrides the account's email settings: sender name and email, email language, subject and body, brand logo, copy of the signed document to the sender, reminders and their hours, the workflow's time zone, and who may pick templates (including people who are not board members). A verified custom domain affects the sender email here the same way it does in account settings.

## Signature Collection

| Setting | Rules |
| --- | --- |
| Status column for the workflow's steps | Required when Sign Anywhere is on |
| Signed Docs File Column (where signed PDFs are stored) | Required when Sign Anywhere is on |
| Sign Anywhere (signing without fixed signature fields) | Needs Use Stored Documents on the General tab, and at least one email column |
| Receiver email columns | Email, people, mirrored email or text columns. Required when Sign Anywhere is on |

## Share & Track (signing links)

May be locked on some plans. When it is switched on:

| Setting | Rules |
| --- | --- |
| Trigger status column | Required |
| Trigger status label | Required |
| Link column (where the signing link is written) | Required |
| Expire links | Optional. If on, the number of days must be a whole number of 1 or more |
| Email verification for the link | Optional; a paid-plan feature |

## GetSign Generate

When it is switched on:

| Setting | Rules |
| --- | --- |
| Trigger status column and label | Both required |
| File column for the generated document | Required |
| Output file type | PDF or DOCX. DOCX only works with a template that supports it |
| Custom file names | Optional. If on, the name pattern needs at least one part |

A document is generated either from **Generate Document** or automatically when the item's status reaches the configured label.

## Security

Require OTP (a paid-plan feature), digital certification, watermark and showing the audit log. These follow the account's security settings until the workflow's override is switched on.

## Form Filler

A paid-plan feature. The form itself is edited in a separate GetSign form editor, which can only be opened once the workflow has been saved: while creating a workflow, save it first, then edit the form from the workflow's settings.

## Approval Rules

- Approval can be switched on per workflow.
- The workflow either uses the account's rules or has rules of its own.
- A rule has a name, a main column with a condition and value, up to 10 further conditions, a people column that names the approvers, an optional note, and an on/off switch.
- Rules are checked at the moment of sending. There is no way to preview beforehand whether a send will need approval; when it does, the send waits for the approvers instead of going out.`,
  },
  {
    id: "getsign-ref-send-generate-and-templates",
    title: "GetSign step by step: first-time setup, sending, generating and signing links",
    keywords: ["getsign", "send document", "generate document", "generate link", "signing link", "create document", "onboarding", "template gallery", "recipients", "signers"],
    from: [{ section: "End-to-end flows", hash: "6d20c7dfc58b" }],
    body: `## First-time setup (Create Document)

1. **Upload**: name the template, optionally describe it, and upload the file. This creates the template in the gallery and may open the template editor.
2. **Settings**: the account settings tabs.
3. **Create workflow**: the workflow wizard, usually with the new template already selected.
4. **Send**: pick the monday item or subitem, then set recipients and placeholder values and send by email or as a signing link.

The same setup starts when **Send Document** is opened on a board that has no workflow yet.

## Send Document

On a board with no workflows, Send Document runs the first-time setup above. On a board with workflows:

1. Select the workflow.
2. Select the item (or subitem).
3. Review and share: assign signers, fill placeholder fields, see any approval message, and choose email or link.
4. Success: the screen shows how many documents went out and to whom.

A workflow can also be created from here; after it is created the app continues straight to sending from it, and finishes back on the dashboard.

## Generate Document

Needs a board and at least one workflow with generation set up.

- Opened without a board: a message asks to open the app from a monday board.
- No suitable workflow: the screen offers to create one, already set to generate documents.
- Otherwise: pick the workflow, pick the item, generate, and follow the progress and success messages.

## Generate Link

Works like Generate Document, but uses the workflow's **Share & Track** settings. The recipient columns for the signing link are chosen and saved before the link is generated. A workflow created from here is set up for signing links and comes back to Generate Link already selected.

## Template gallery

- Lists the templates available to the account and board.
- **Create new** asks for the template type and then the upload, the same upload as in Create Document.
- Template content is edited in the separate GetSign template editor, not inside the board view.

## Workflows list and a single workflow

From the list: search, create, and open a workflow. On a workflow: see its templates, rename it, delete it, **Send**, **Edit settings**, and open its template documents.

## Signing from an item

The signing view opened from a monday item follows that workflow's Use Stored Documents and Sign Anywhere settings and its column mappings.

## The welcome questions

The first screens a new account sees (business name, type, role, website) only describe the business. They do not configure workflows or sending.`,
  },
  {
    id: "getsign-ref-troubleshooting",
    title: "GetSign troubleshooting: a workflow will not save, a setting has no effect, a link or document does not appear",
    keywords: ["getsign", "cannot save", "validation", "error", "locked", "upgrade", "override", "inherit", "stripe", "payment fields", "signing link missing", "subitems", "status label"],
    from: [
      { section: "Cross-cutting rules (chatbot troubleshooting)", hash: "f39f5e92ca88" },
      { section: "Suggested chatbot answer patterns", hash: "89f177ce9364" },
    ],
    body: `## A workflow will not save

| Message or symptom | Cause |
| --- | --- |
| Workflow name required | The name is empty |
| Select at least one template | No template is attached |
| Select stored documents file column | Use Stored Documents is on but no file column is chosen |
| Sign Anywhere errors | An email column, the signed-documents file column or the status column is missing, or Use Stored Documents is off |
| Share & Track or Generate errors | The section is switched on but its status column, status label or output column is missing |
| Invitation expiry | Link expiry is on and the days are not a whole number of 1 or more |
| Trigger column value | A status column is chosen without a status label |

Every status trigger (automatic sending, Share & Track, GetSign Generate) needs both the status column and the label.

## Column pickers show the wrong columns

In a subitem workflow the column pickers list the subitem columns, not the parent board's. Items or subitems is chosen in step 1 when the workflow is created and cannot be changed later: choose subitems when signing happens on subitem rows.

## A setting is locked

Branding, OTP, digital signature, Share & Track links, more than one template per workflow, Form Filler, payments and custom domain can be locked depending on the plan. A locked setting shows a lock tag and cannot be switched on; upgrading the plan unlocks it.

## "I changed account settings but the workflow did not change"

Check the **Override** switches on the workflow's General, Security and Approval Rules tabs. A workflow follows the account defaults only while the override for that section is off.

## Payments

Stripe is connected under **Settings → Payments**. Payment fields are set up on the template in the template editor. A workflow can refuse to send when its templates have payment fields and Stripe is not connected.

## Common questions

**Where is the default email sender set?** In **Settings → General**. Workflows use it unless the workflow overrides its general settings on its own General tab.

**Where are signed PDFs mapped to a column?** In the workflow: **Configure → Signature Collection → Signed Docs File Column**. For signing without fields placed on a template, see **Sign Anywhere**, which needs **Use Stored Documents** on the General tab.

**How are PDFs generated when a status changes?** Create a workflow for **Generate Documents**, or switch on **GetSign Generate** in the Configure step of a Collect Signatures workflow. Then either use **GetSign Generate → Generate Document** on the dashboard or let the status trigger do it.

**The signing link does not appear on the item.** Switch on **Share & Track** and set the status column, the label and the link column, or use **Generate Link**. Check whether Share & Track is locked on the plan.

**Why is there only a Generate tab when creating a workflow?** The workflow was started from **Generate Document** or set to **Generate Documents**. Only the Generate settings are needed for that.

## What GetSign does not have

- No proposal editor inside the board view.
- No way to check in advance whether a send will need approval; approval rules are applied when the document is sent.`,
  },
];
