import nodemailer from "nodemailer";
import type { Lead } from "../types/lead.js";
import type { AppSettings } from "../types/settings.js";
import { logger } from "../utils/logger.js";
import { leadsToEmailCsv } from "./csv.service.js";

export async function sendDailyReport(
  toEmail: string,
  companyName: string,
  leads: Lead[],
  date: string,
  settings: Partial<AppSettings>,
  isTest = false,
): Promise<void> {
  const smtpHost = settings.smtp_host;
  const smtpPort = parseInt(settings.smtp_port || "587", 10);
  const smtpUser = settings.smtp_user;
  const smtpPass = settings.smtp_pass;
  const fromEmail = settings.smtp_from || smtpUser;

  if (!smtpHost || !smtpUser || !smtpPass) {
    logger.warn("SMTP not configured — skipping email");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const byType = leads.reduce<Record<string, number>>((acc, lead) => {
    acc[lead.lead_type] = (acc[lead.lead_type] || 0) + 1;
    return acc;
  }, {});

  const summaryRows = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([type, count]) =>
        `<tr><td style="padding:4px 12px">${type}</td><td style="padding:4px 12px;text-align:right"><strong>${count}</strong></td></tr>`,
    )
    .join("");

  const subject = isTest
    ? `✅ Atlas Email Test — ${companyName}`
    : `🏠 Atlas Daily Leads — ${leads.length} new leads for ${date}`;

  const bodyHtml = isTest
    ? `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a1a2e;color:white;padding:24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">Atlas Lead Engine</h2>
          <p style="margin:4px 0 0;opacity:0.7">${companyName} — Email Test</p>
        </div>
        <div style="background:#f8f9fa;padding:24px;border-radius:0 0 8px 8px">
          <h3 style="margin-top:0;color:#28a745">✅ Your email is configured correctly!</h3>
          <p>This is a test message from Atlas. Your daily lead reports will be delivered to this address every morning at 6:00 AM EST.</p>
        </div>
      </div>`
    : `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a1a2e;color:white;padding:24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">Atlas Lead Engine</h2>
          <p style="margin:4px 0 0;opacity:0.7">${companyName} — Daily Report</p>
        </div>
        <div style="background:#f8f9fa;padding:24px;border-radius:0 0 8px 8px">
          <h3 style="margin-top:0">📊 Today's Summary — ${date}</h3>
          <p><strong>${leads.length} total new leads</strong> found across your target counties.</p>
          <table style="border-collapse:collapse;width:100%;background:white;border-radius:6px;overflow:hidden">
            <thead><tr style="background:#e9ecef">
              <th style="padding:8px 12px;text-align:left">Lead Type</th>
              <th style="padding:8px 12px;text-align:right">Count</th>
            </tr></thead>
            <tbody>${summaryRows || '<tr><td colspan="2" style="padding:8px 12px;color:#999">No leads today</td></tr>'}</tbody>
          </table>
          <p style="margin-top:20px">The full lead list is attached as a CSV file.</p>
        </div>
      </div>`;

  await transporter.sendMail({
    from: `Atlas Lead Engine <${fromEmail}>`,
    to: toEmail,
    subject,
    html: bodyHtml,
    attachments: isTest
      ? []
      : [{ filename: `atlas-leads-${date}.csv`, content: leadsToEmailCsv(leads), contentType: "text/csv" }],
  });

  logger.info({ toEmail, isTest, leadCount: leads.length }, "Email sent");
}
