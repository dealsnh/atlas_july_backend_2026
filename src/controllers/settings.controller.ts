import type { Request, Response } from "express";
import { clientConfig } from "../config/constants.js";
import { sendDailyReport } from "../services/email.service.js";
import { getMaskedSettings, getRawSettings, updateSettings } from "../services/settings.service.js";
import { ApiError } from "../utils/api-error.js";
import { successResponse } from "../utils/api-response.js";

export async function getSettingsHandler(_req: Request, res: Response): Promise<void> {
  successResponse(res, 200, undefined, await getMaskedSettings());
}

export async function saveSettingsHandler(req: Request, res: Response): Promise<void> {
  await updateSettings(req.body as Record<string, unknown>);
  successResponse(res, 200, undefined, { ok: true });
}

export async function testEmailHandler(req: Request, res: Response): Promise<void> {
  const settings = await getRawSettings();
  const testRecipient =
    (req.body as { email?: string }).email || settings.email_recipients?.split(",")[0]?.trim();

  if (!testRecipient) {
    throw ApiError.badRequest("No recipient email");
  }

  if (
    !settings.smtp_host ||
    !settings.smtp_user ||
    !settings.smtp_pass ||
    settings.smtp_pass.startsWith("placeholder")
  ) {
    throw ApiError.badRequest("SMTP not configured");
  }

  await sendDailyReport(
    testRecipient,
    clientConfig.name,
    [],
    new Date().toISOString().split("T")[0] ?? "",
    settings,
    true,
  );

  successResponse(res, 200, undefined, {
    ok: true,
    message: `Test email sent to ${testRecipient}`,
  });
}
