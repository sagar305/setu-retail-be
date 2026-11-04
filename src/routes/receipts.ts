// Receipt Designer (saved receipt designs, a business default, per-branch
// choice) and the Barcode Generator's "make in-store barcodes".
import "../zodOpenApi.js";
import { randomInt } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole } from "../auth/middleware.js";
import type { ReceiptTemplate } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { audit } from "../services/audit.js";
import { requireTool } from "../services/books.js";
import { changes } from "../lib/diff.js";
import { branchFor } from "./access.js";

const Text = (max: number) => z.string().trim().max(max);
export const ReceiptTemplateBody = z.object({
  name: Text(60).min(1, "Give the design a name."),
  paperSize: z.enum(["80mm", "58mm", "a4"]),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #26306B."),
  headerText: Text(300).optional(),
  footerText: Text(300).optional(),
  showLogo: z.boolean().optional(),
  showBusinessInfo: z.boolean().optional(),
  showGstin: z.boolean().optional(),
  showHsn: z.boolean().optional(),
  showGstSummary: z.boolean().optional(),
  showAmountWords: z.boolean().optional(),
  boldTotals: z.boolean().optional(),
  separator: z.enum(["dashed", "solid", "none"]).optional(),
});
export const BranchReceiptBody = z.object({ templateId: z.uuid().nullable() });
export const BarcodeGenerateBody = z.object({ productIds: z.array(z.uuid()).min(1).max(1000) });

export const ReceiptTemplateDto = z.object({
  id: z.string(),
  name: z.string(),
  paperSize: z.enum(["80mm", "58mm", "a4"]),
  accentColor: z.string(),
  headerText: z.string(),
  footerText: z.string(),
  showLogo: z.boolean(),
  showBusinessInfo: z.boolean(),
  showGstin: z.boolean(),
  showHsn: z.boolean(),
  showGstSummary: z.boolean(),
  showAmountWords: z.boolean(),
  boldTotals: z.boolean(),
  separator: z.enum(["dashed", "solid", "none"]),
  isDefault: z.boolean(),
});

export const templateDto = (t: ReceiptTemplate): z.infer<typeof ReceiptTemplateDto> => ({
  id: t.id,
  name: t.name,
  paperSize: t.paperSize as "80mm",
  accentColor: t.accentColor,
  headerText: t.headerText,
  footerText: t.footerText,
  showLogo: t.showLogo,
  showBusinessInfo: t.showBusinessInfo,
  showGstin: t.showGstin,
  showHsn: t.showHsn,
  showGstSummary: t.showGstSummary,
  showAmountWords: t.showAmountWords,
  boldTotals: t.boldTotals,
  separator: t.separator as "dashed",
  isDefault: t.isDefault,
});

/** EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  const sum = [...first12].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}
/** An in-store EAN-13: starts with 2 (reserved for shops' own codes). */
export function inStoreEan13(rand: () => number = () => randomInt(0, 10)): string {
  const body = `2${Array.from({ length: 11 }, () => rand()).join("")}`;
  return `${body}${ean13CheckDigit(body)}`;
}

export function receiptsRouter(ctx: Ctx): Router {
  const router = Router();
  // /products/... is already authenticated by the catalogue router.
  const signIn = authenticate(ctx);
  const once = (req: Request, res: Response, next: NextFunction) => (req.auth ? next() : signIn(req, res, next));
  router.use(["/receipt-templates", "/products/barcodes"], once, requireActivePlan);
  const OM = requireRole("OWNER", "MANAGER");
  const DESIGNER = [OM, requireTool("receipt-designer")];

  // Everyone who bills reads the designs (to print with them).
  router.get("/receipt-templates", async (req, res) => {
    const rows = await ctx.prisma.receiptTemplate.findMany({ where: { accountId: auth(req).account.id, archivedAt: null }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
    res.json({ templates: rows.map(templateDto) });
  });

  router.post("/receipt-templates", ...DESIGNER, async (req, res) => {
    const a = auth(req);
    const body = ReceiptTemplateBody.parse(req.body);
    const first = (await ctx.prisma.receiptTemplate.count({ where: { accountId: a.account.id, archivedAt: null } })) === 0;
    const t = await ctx.prisma.receiptTemplate.create({ data: { ...body, accountId: a.account.id, isDefault: first } });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "receipt_design.created", entityType: "receipt_template", entityId: t.id, data: { name: t.name } });
    res.status(201).json({ template: templateDto(t) });
  });

  async function find(accountId: string, id: unknown) {
    const t = await ctx.prisma.receiptTemplate.findFirst({ where: { id: String(id), accountId, archivedAt: null } });
    if (!t) throw new AppError(404, "not_found", "Receipt design not found.");
    return t;
  }

  router.patch("/receipt-templates/:id", ...DESIGNER, async (req, res) => {
    const a = auth(req);
    const t = await find(a.account.id, req.params.id);
    const body = ReceiptTemplateBody.partial().parse(req.body);
    const updated = await ctx.prisma.receiptTemplate.update({ where: { id: t.id }, data: body });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "receipt_design.updated", entityType: "receipt_template", entityId: t.id, data: { name: t.name, changes: changes(t, body) } as never });
    res.json({ template: templateDto(updated) });
  });

  router.post("/receipt-templates/:id/default", ...DESIGNER, async (req, res) => {
    const a = auth(req);
    const t = await find(a.account.id, req.params.id);
    await ctx.prisma.$transaction([
      ctx.prisma.receiptTemplate.updateMany({ where: { accountId: a.account.id }, data: { isDefault: false } }),
      ctx.prisma.receiptTemplate.update({ where: { id: t.id }, data: { isDefault: true } }),
    ]);
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "receipt_design.default", entityType: "receipt_template", entityId: t.id, data: { name: t.name } });
    res.json({ template: templateDto({ ...t, isDefault: true }) });
  });

  router.delete("/receipt-templates/:id", ...DESIGNER, async (req, res) => {
    const a = auth(req);
    const t = await find(a.account.id, req.params.id);
    await ctx.prisma.$transaction(async (tx) => {
      await tx.receiptTemplate.update({ where: { id: t.id }, data: { archivedAt: ctx.now(), isDefault: false } });
      await tx.branch.updateMany({ where: { accountId: a.account.id, receiptTemplateId: t.id }, data: { receiptTemplateId: null } });
      // Another design becomes the default.
      if (t.isDefault) {
        const next = await tx.receiptTemplate.findFirst({ where: { accountId: a.account.id, archivedAt: null }, orderBy: { createdAt: "asc" } });
        if (next) await tx.receiptTemplate.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "receipt_design.deleted", entityType: "receipt_template", entityId: t.id, data: { name: t.name } });
    res.status(204).end();
  });

  // A branch prints with its own design, or the business default (null).
  router.put("/receipt-templates/branches/:branchId", ...DESIGNER, async (req, res) => {
    const a = auth(req);
    const branch = branchFor(a, req.params.branchId, true);
    const { templateId } = BranchReceiptBody.parse(req.body);
    if (templateId) await find(a.account.id, templateId);
    await ctx.prisma.branch.update({ where: { id: branch.id }, data: { receiptTemplateId: templateId } });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: branch.id, action: "receipt_design.branch", entityType: "branch", entityId: branch.id, data: { templateId } });
    res.json({ branchId: branch.id, templateId });
  });

  // ── Barcode Generator: in-store EAN-13 for products without a barcode ──
  router.post("/products/barcodes", OM, requireTool("barcode-generator"), async (req, res) => {
    const a = auth(req);
    const { productIds } = BarcodeGenerateBody.parse(req.body);
    const products = await ctx.prisma.product.findMany({ where: { id: { in: productIds }, accountId: a.account.id, archivedAt: null } });
    const taken = new Set((await ctx.prisma.product.findMany({ where: { accountId: a.account.id, barcode: { not: "" } }, select: { barcode: true } })).map((p) => p.barcode));
    const made: { productId: string; barcode: string }[] = [];
    for (const p of products) {
      if (p.barcode) continue;
      let code = inStoreEan13();
      while (taken.has(code)) code = inStoreEan13();
      taken.add(code);
      await ctx.prisma.product.update({ where: { id: p.id }, data: { barcode: code } });
      made.push({ productId: p.id, barcode: code });
    }
    if (made.length) await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "product.barcodes_generated", entityType: "product", data: { count: made.length } });
    res.json({ generated: made, skipped: products.length - made.length });
  });

  return router;
}
