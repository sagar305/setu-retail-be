import type { Mail } from "./mailer.js";

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(heading: string, paragraphs: string[], cta: { label: string; url: string }, footnote: string): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#0E1124">${escape(p)}</p>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#F2EFE7;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#FFFFFF;border-radius:14px;border:1px solid #D9D3C4" cellpadding="0" cellspacing="0">
<tr><td style="background:#26306B;border-radius:14px 14px 0 0;padding:18px 24px;color:#FFFFFF;font-weight:bold;font-size:16px">Setu Retail</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:20px;color:#0E1124">${escape(heading)}</h1>
${body}
<p style="margin:22px 0"><a href="${escape(cta.url)}" style="display:inline-block;background:#26306B;color:#FFFFFF;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">${escape(cta.label)}</a></p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#5F6478">${escape(footnote)}<br>${escape(cta.url)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

function text(heading: string, paragraphs: string[], cta: { label: string; url: string }, footnote: string): string {
  return [heading, "", ...paragraphs, "", `${cta.label}: ${cta.url}`, "", footnote].join("\n");
}

function mail(to: string, subject: string, heading: string, paragraphs: string[], cta: { label: string; url: string }, footnote: string): Mail {
  return { to, subject, html: layout(heading, paragraphs, cta, footnote), text: text(heading, paragraphs, cta, footnote) };
}

export function verifyEmailMail(to: string, name: string, url: string): Mail {
  return mail(
    to,
    "Verify your email for Setu Retail",
    `Welcome, ${name}`,
    ["Verify your email to start your 3-month free trial of Setu Retail Basic."],
    { label: "Verify email", url },
    "This link works once and expires in 24 hours. If you didn't sign up, ignore this email.",
  );
}

export function resetPasswordMail(to: string, name: string, url: string): Mail {
  return mail(
    to,
    "Reset your Setu Retail password",
    "Reset your password",
    [`Hi ${name}, someone asked to reset the password for this email. If it was you, choose a new password below.`],
    { label: "Choose a new password", url },
    "This link works once and expires in 1 hour. Signing in again will be needed on every device.",
  );
}

export function inviteMail(to: string, name: string, inviter: string, business: string, role: string, url: string): Mail {
  return mail(
    to,
    `${inviter} added you to ${business} on Setu Retail`,
    `You've been added to ${business}`,
    [`Hi ${name}, ${inviter} has added you as ${role} on Setu Retail.`, "Set your password to start."],
    { label: "Set my password", url },
    "This link works once and expires in 7 days.",
  );
}

/** "Your plan ends soon" (automatic at 14, 7 and 1 days, or sent by the Setu team). */
export function planEndingMail(to: string, name: string, business: string, planName: string, daysLeft: number, endsOn: string, url: string): Mail {
  const when = daysLeft <= 1 ? "tomorrow" : `in ${daysLeft} days`;
  return mail(
    to,
    `Your Setu Retail plan ends ${when}`,
    `Your plan ends ${when}`,
    [
      `Hi ${name}, the ${planName} plan for ${business} ends on ${endsOn}.`,
      "Renew with a license key to keep billing without a break. Your data stays safe either way; after the end date only the owner can sign in, to renew.",
    ],
    { label: "Renew now", url },
    "Buy a key on setutechnology.com, then redeem it in Settings → Plan & key.",
  );
}

/** Sent by the Setu team to an account whose plan has already ended. */
export function planEndedMail(to: string, name: string, business: string, url: string): Mail {
  return mail(
    to,
    "Your Setu Retail plan has ended",
    "Your plan has ended",
    [`Hi ${name}, the plan for ${business} has ended. Your data is kept: redeem a license key to start billing again.`],
    { label: "Renew now", url },
    "Buy a key on setutechnology.com, then redeem it in Settings → Plan & key.",
  );
}

/** A Contact-sales key, issued by the Setu team for one account. */
export function customKeyMail(to: string, name: string, business: string, key: string, summary: string, url: string): Mail {
  return mail(
    to,
    "Your Setu Retail license key",
    "Your license key is ready",
    [`Hi ${name}, here is the Setu Retail key for ${business}: ${summary}.`, key, "It works only on your account. Sign in as the owner and press the button below; the key is filled in for you."],
    { label: "Redeem in Setu Retail", url },
    "Keep this key private. Questions? Reply to this email.",
  );
}

/** Invite (or reset) for a Setu team member. */
export function adminInviteMail(to: string, name: string, url: string, reset: boolean): Mail {
  return mail(
    to,
    reset ? "Set a new Setu Retail admin password" : "You've been added to the Setu Retail admin",
    reset ? "Set a new admin password" : "Welcome to the Setu Retail admin",
    [
      `Hi ${name}, ${reset ? "your admin sign-in was reset" : "you can now manage Setu Retail accounts"}.`,
      "Set a password, then link an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) on your first sign-in.",
    ],
    { label: "Set my password", url },
    "This link works once and expires in 48 hours.",
  );
}
