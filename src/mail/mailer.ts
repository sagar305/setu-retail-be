export type Mail = { to: string; subject: string; text: string; html: string };

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Sends through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(mail: Mail): Promise<void> {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}`);
  }
}

/** Development without a Resend key: print the email (and its link) to the log. */
export class LogMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    console.log(`\n📧 To: ${mail.to}\n   Subject: ${mail.subject}\n${mail.text.replace(/^/gm, "   ")}\n`);
  }
}

/** Tests: keep what was sent. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
  last(to?: string): Mail | undefined {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
  /** The first link to the app in the last email. */
  lastLink(to?: string): string | undefined {
    return this.last(to)?.text.match(/https?:\/\/\S+/)?.[0];
  }
}
