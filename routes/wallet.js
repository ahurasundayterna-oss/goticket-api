// backend/routes/wallet.js
"use strict";

const express = require("express");
const router  = express.Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");
const { requireSuperAdmin, requireBranchMember } = require("../middleware/role");
const {
  creditWallet,
  initiateMonnifyFunding,
  getExistingMonnifyAccount,
  verifyWalletWebhookSignature,
} = require("../services/wallet");

/* ══════════════════════════════════════════════
   GET /api/wallet
══════════════════════════════════════════════ */
router.get("/", auth, requireBranchMember, async (req, res) => {
  try {
    const branchId = req.user.role === "SUPER_ADMIN"
      ? req.query.branchId
      : req.user.branchId;

    if (!branchId) {
      return res.status(400).json({ message: "branchId is required" });
    }

    const branch = await prisma.branch.findUnique({
      where:  { id: branchId },
      select: {
        id:            true,
        name:          true,
        walletBalance: true,
        walletEnabled: true,
        updatedAt:     true,
      },
    });

    if (!branch) return res.status(404).json({ message: "Branch not found" });

    if (req.user.role !== "SUPER_ADMIN" && req.user.branchId !== branchId) {
      return res.status(403).json({ message: "Access denied" });
    }

    return res.json({
      branchId:   branch.id,
      branchName: branch.name,
      balance:    branch.walletBalance,
      enabled:    branch.walletEnabled,
      lowBalance: branch.walletBalance < 1000,
      exhausted:  branch.walletBalance < 50,
      updatedAt:  branch.updatedAt,
    });
  } catch (err) {
    console.error("WALLET GET ERROR:", err);
    return res.status(500).json({ message: "Error fetching wallet" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/wallet/transactions
══════════════════════════════════════════════ */
router.get("/transactions", auth, requireBranchMember, async (req, res) => {
  try {
    const branchId = req.user.role === "SUPER_ADMIN"
      ? req.query.branchId
      : req.user.branchId;

    if (!branchId) {
      return res.status(400).json({ message: "branchId is required" });
    }

    if (req.user.role !== "SUPER_ADMIN" && req.user.branchId !== branchId) {
      return res.status(403).json({ message: "Access denied" });
    }

    const page  = Math.max(1, parseInt(req.query.page  || "1"));
    const limit = Math.min(100, parseInt(req.query.limit || "20"));
    const type  = req.query.type?.toUpperCase();

    const where = {
      branchId,
      ...(type && ["CREDIT", "DEBIT"].includes(type) ? { type } : {}),
    };

    const [total, transactions] = await Promise.all([
      prisma.walletTransaction.count({ where }),
      prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip:    (page - 1) * limit,
        take:    limit,
      }),
    ]);

    return res.json({
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      transactions,
    });
  } catch (err) {
    console.error("WALLET TRANSACTIONS ERROR:", err);
    return res.status(500).json({ message: "Error fetching transactions" });
  }
});

/* ══════════════════════════════════════════════
   POST /api/wallet/fund
   ──────────────────────────────────────────────
   1. If a PENDING top-up already exists for this
      branch, reuse its Monnify reserved account
      instead of creating a duplicate (422).
   2. If the existing Monnify account can't be
      fetched, mark it FAILED and create fresh.
   3. Otherwise create a brand new transaction
      and Monnify reserved account.
══════════════════════════════════════════════ */
router.post("/fund", auth, requireBranchMember, async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const { amount } = req.body;

    if (!branchId) {
      return res.status(400).json({ message: "No branch associated with this account" });
    }
    if (!amount || isNaN(amount) || Number(amount) < 100) {
      return res.status(400).json({ message: "Minimum funding amount is ₦100" });
    }

    const branch = await prisma.branch.findUnique({
      where:  { id: branchId },
      select: { id: true, name: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });

    // ── Check for existing PENDING top-up ──────────────────────────
    // Reuse it so we never hit a 422 duplicate on Monnify
    const existingTx = await prisma.walletTransaction.findFirst({
      where:   { branchId, type: "CREDIT", status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });

    if (existingTx) {
      console.log(`[Wallet] Found existing PENDING tx: ${existingTx.reference} — attempting reuse`);

      try {
        const monnifyData = await getExistingMonnifyAccount(existingTx.reference);

        console.log(`[Wallet] Reusing Monnify account for ref: ${existingTx.reference}`);

        return res.status(200).json({
          message:       "You have a pending top-up. Transfer to complete it.",
          reference:     existingTx.reference,
          amount:        existingTx.amount,
          accountNumber: monnifyData.accountNumber,
          bankName:      monnifyData.bankName,
          accountName:   monnifyData.accountName,
          instruction:   `Transfer exactly ₦${Number(existingTx.amount).toLocaleString("en-NG")} to confirm your wallet top-up.`,
        });
      } catch (reuseErr) {
        // Monnify account unretrievable — cancel stuck tx and fall through to fresh creation
        console.warn(`[Wallet] Could not reuse existing tx (${reuseErr.message}) — marking FAILED and creating fresh`);
        await prisma.walletTransaction.update({
          where: { id: existingTx.id },
          data:  { status: "FAILED" },
        });
      }
    }

    // ── Create fresh transaction + Monnify account ─────────────────
    const reference = `WFUND-${branchId.slice(0, 6)}-${Date.now()}`;

    await prisma.walletTransaction.create({
      data: {
        branchId,
        amount:      Number(amount),
        type:        "CREDIT",
        status:      "PENDING",
        reference,
        description: `Wallet top-up — ₦${amount}`,
      },
    });

    const monnifyData = await initiateMonnifyFunding({
      branchId,
      branchName: branch.name,
      amount:     Number(amount),
      reference,
    });

    console.log(`[Wallet] Fund request — Branch: ${branch.name} | Amount: ₦${amount} | Ref: ${reference}`);

    return res.status(201).json({
      message:       "Transfer details generated. Send the exact amount to confirm.",
      reference,
      amount:        Number(amount),
      accountNumber: monnifyData.accountNumber,
      bankName:      monnifyData.bankName,
      accountName:   monnifyData.accountName,
      instruction:   `Transfer exactly ₦${Number(amount).toLocaleString("en-NG")} to confirm your wallet top-up.`,
    });

  } catch (err) {
    console.error("WALLET FUND ERROR:", err.message);
    return res.status(500).json({ message: "Failed to initialize wallet funding. Try again." });
  }
});

/* ══════════════════════════════════════════════
   POST /api/wallet/webhook
   Kept here as fallback but primary handling
   is now inside monnifyWebhook.js unified handler.
══════════════════════════════════════════════ */
router.post(
  "/webhook",
  require("express").raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["monnify-signature"];
    const rawBody   = req.body;

    if (!signature || !verifyWalletWebhookSignature(rawBody, signature)) {
      console.warn("[Wallet Webhook] Invalid or missing signature — rejected");
      return res.status(401).json({ error: "Invalid signature" });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    console.log("[Wallet Webhook] Received:", JSON.stringify(payload, null, 2));
    res.status(200).json({ received: true });

    const { eventType, eventData } = payload;

    const SUCCESS_EVENTS = ["SUCCESSFUL_TRANSACTION", "PAYMENT_STATUS_CHANGED"];
    if (!SUCCESS_EVENTS.includes(eventType)) return;
    if (eventType === "PAYMENT_STATUS_CHANGED" && eventData?.paymentStatus !== "PAID") return;

    const productRef = eventData?.product?.reference || eventData?.accountReference || "";
    const reference  = productRef.replace(/^WALLET-/, "");
    const amountPaid = eventData?.amountPaid || 0;

    try {
      const transaction = await prisma.walletTransaction.findUnique({
        where: { reference },
      });

      if (!transaction) {
        console.warn(`[Wallet Webhook] No transaction for reference: ${reference}`);
        return;
      }

      if (transaction.status === "SUCCESS") {
        console.log(`[Wallet Webhook] Already credited: ${reference} — skipping`);
        return;
      }

      await prisma.$transaction(async (tx) => {
        await creditWallet(
          tx,
          transaction.branchId,
          amountPaid || transaction.amount,
          reference,
          `Wallet top-up confirmed — ₦${amountPaid || transaction.amount}`
        );
      });

      console.log(`[Wallet Webhook] ✅ Credited ₦${amountPaid} to branch ${transaction.branchId} | Ref: ${reference}`);

    } catch (err) {
      console.error("[Wallet Webhook] Processing error:", err.message);
    }
  }
);

/* ══════════════════════════════════════════════
   POST /api/wallet/deposit (Super Admin only)
══════════════════════════════════════════════ */
router.post("/deposit", auth, requireSuperAdmin, async (req, res) => {
  try {
    const { branchId, amount, reference, description } = req.body;

    if (!branchId) return res.status(400).json({ message: "branchId is required" });
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ message: "Amount must be greater than zero" });
    }

    const ref = reference || `SADEP-${branchId.slice(0, 6)}-${Date.now()}`;

    const branch = await prisma.$transaction(async (tx) => {
      await tx.walletTransaction.create({
        data: {
          branchId,
          amount:      Number(amount),
          type:        "CREDIT",
          status:      "SUCCESS",
          reference:   ref,
          description: description || `Manual deposit by Super Admin — ₦${amount}`,
        },
      });

      return tx.branch.update({
        where:  { id: branchId },
        data:   { walletBalance: { increment: Number(amount) } },
        select: { id: true, name: true, walletBalance: true },
      });
    });

    console.log(`[Wallet] SA deposit ₦${amount} → ${branch.name} | New balance: ₦${branch.walletBalance}`);

    return res.status(201).json({
      message:    `₦${amount} deposited to ${branch.name}`,
      newBalance: branch.walletBalance,
      reference:  ref,
    });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ message: "Duplicate reference — transaction already exists" });
    }
    console.error("WALLET DEPOSIT ERROR:", err);
    return res.status(500).json({ message: "Deposit failed" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/wallet/all (Super Admin only)
══════════════════════════════════════════════ */
router.get("/all", auth, requireSuperAdmin, async (req, res) => {
  try {
    const branches = await prisma.branch.findMany({
      select: {
        id:            true,
        name:          true,
        walletBalance: true,
        walletEnabled: true,
        park:          { select: { name: true } },
        _count:        { select: { walletTransactions: true } },
      },
      orderBy: { walletBalance: "asc" },
    });

    return res.json(branches.map(b => ({
      branchId:          b.id,
      branchName:        b.name,
      parkName:          b.park?.name,
      balance:           b.walletBalance,
      enabled:           b.walletEnabled,
      totalTransactions: b._count.walletTransactions,
      lowBalance:        b.walletBalance < 1000,
      exhausted:         b.walletBalance < 50,
    })));
  } catch (err) {
    console.error("WALLET ALL ERROR:", err);
    return res.status(500).json({ message: "Error fetching wallets" });
  }
});

/* ══════════════════════════════════════════════
   PATCH /api/wallet/toggle (Super Admin only)
══════════════════════════════════════════════ */
router.patch("/toggle", auth, requireSuperAdmin, async (req, res) => {
  try {
    const { branchId, enabled } = req.body;

    if (!branchId || typeof enabled !== "boolean") {
      return res.status(400).json({ message: "branchId and enabled (boolean) are required" });
    }

    const branch = await prisma.branch.update({
      where:  { id: branchId },
      data:   { walletEnabled: enabled },
      select: { id: true, name: true, walletBalance: true, walletEnabled: true },
    });

    return res.json({
      message: `Wallet ${enabled ? "enabled" : "disabled"} for ${branch.name}`,
      branch,
    });
  } catch (err) {
    console.error("WALLET TOGGLE ERROR:", err);
    return res.status(500).json({ message: "Toggle failed" });
  }
});

module.exports = router;