/**
 * Create a product that the catalogue does not have, from the bill being written.
 *
 * ## What this does and does not do
 *
 * It creates a **catalogue entry** and puts it on the current bill. It does **not**
 * receive stock, and that distinction is the whole reason this component has a paragraph
 * of explanation on screen rather than just two fields.
 *
 * `POST /products` writes `products` and nothing else — no `stock_movements` row, no
 * `inventory_balances` change — which is correct: a part existing in the catalogue is not
 * the same claim as a part being on the shelf. Invariant 4 says every stock change is a
 * movement row, and there is no movement here to write. So the new product's stock is
 * **zero**, and selling it immediately is an oversell that the server will challenge at
 * finalisation exactly as it should. The dialog says so, because a cashier who is not
 * told will read the override prompt as a bug.
 *
 * Physical arrivals are still recorded on the Stock screen, which is the only place that
 * writes a receipt movement. An authorised sale against insufficient recorded stock is
 * a separate, explicit and audited decision after the server refuses the first attempt.
 *
 * ## Duplicates
 *
 * The affordance that opens this is offered **only when the search found nothing** — and
 * the catalogue search already includes a trigram tier, so "nothing" means no exact, no
 * prefix, no alias and no fuzzy match. That is what keeps this from becoming the fourth
 * spelling of one clutch plate, which is the risk `ItemCell` was originally written to
 * avoid.
 *
 * ## Why the id is generated here
 *
 * `POST /products` accepts a client-generated `id` and is idempotent on it. The id is
 * minted once, when the dialog opens, and **reused** by every retry — so a double press,
 * a slow network the cashier gives up on, or a dropped reply followed by a retry all
 * converge on one product rather than three. Minting it inside the submit handler would
 * defeat exactly that.
 */

import { useRef, useState } from 'react';

import { catalog } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Product } from '@/api/types';
import { Button, Dialog, Field, Panel } from '@/components/primitives';
import { uuidv7 } from '@/lib/ids';
import { tryParseMoney } from '@/lib/money';
import { BILLING, COMMON, ERRORS } from '@/lib/strings';

/**
 * The unit a new part gets.
 *
 * `NOS` ("Numbers") is the first of the seeded defaults and the one auto spares are
 * counted in. It is not guessed per product: a part that is genuinely sold by the litre
 * or the metre needs the Stock screen, where the unit can be chosen — offering a unit
 * dropdown here would turn a two-field interruption into a form, which is what makes
 * staff skip it and write the sale on paper.
 */
const DEFAULT_UNIT_CODE = 'NOS';

/**
 * The owner's stated default minimum-stock threshold.
 *
 * A **string**, like every other quantity that crosses the wire (ADR-013). It lands in
 * `products.reorder_level`, which is what the low-stock warning reads.
 */
const DEFAULT_REORDER_LEVEL = '10';

export interface NewItemDialogProps {
  /** Prefills the name — it is what the cashier already typed into the cell. */
  initialName: string;
  /** Prefills the price when the cell's row already had one typed. */
  initialPrice?: string | undefined;
  onCancel: () => void;
  /** The created product, for the caller to put straight on the bill. */
  onCreated: (product: Product) => void;
}

export function NewItemDialog({
  initialName,
  initialPrice = '',
  onCancel,
  onCreated,
}: NewItemDialogProps) {
  const [name, setName] = useState(initialName);
  const [price, setPrice] = useState(initialPrice);
  const [minQuantity, setMinQuantity] = useState(DEFAULT_REORDER_LEVEL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; price?: string }>({});

  // Minted once, on mount, and reused by every retry. See the module docstring.
  const productId = useRef(uuidv7());
  /** Guards the double press, before the request even leaves. */
  const submitting = useRef(false);

  async function save(): Promise<void> {
    const trimmedName = name.trim();
    const trimmedPrice = price.trim();

    const problems: { name?: string; price?: string } = {};
    if (!trimmedName) problems.name = BILLING.addMissingItemNeedName;
    // Parsed with the money parser rather than `Number`, so `12.345` and `abc` are both
    // refused here instead of becoming a 422 after a round trip.
    if (!trimmedPrice || tryParseMoney(trimmedPrice) === null) {
      problems.price = BILLING.addMissingItemNeedPrice;
    }
    if (problems.name || problems.price) {
      setFieldErrors(problems);
      return;
    }
    setFieldErrors({});

    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const created = await catalog.create({
        id: productId.current,
        name: trimmedName,
        unit_code: DEFAULT_UNIT_CODE,
        // The price typed on the bill becomes the product's selling price, which is
        // what the owner asked for.
        default_selling_price: trimmedPrice,
        reorder_level: minQuantity.trim() || DEFAULT_REORDER_LEVEL,
      });
      onCreated(created);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
      // Released so the cashier can correct and retry. The id is **not** regenerated,
      // so a retry after a reply that was sent but never arrived still resolves to one
      // product.
      submitting.current = false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={BILLING.addMissingItemTitle}
      onDismiss={onCancel}
      actions={
        <>
          <Button variant="quiet" onClick={onCancel}>
            {COMMON.cancel}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {BILLING.addMissingItemSave}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Stated before the fields, not after: what this does is genuinely surprising
            if you expect "add to stock" to add stock. */}
        <Panel tone="info">{BILLING.addMissingItemIntro}</Panel>

        {error ? <Panel tone="danger">{error}</Panel> : null}

        <Field
          label={BILLING.addMissingItemName}
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
        />
        <Field
          label={BILLING.addMissingItemPrice}
          value={price}
          inputMode="decimal"
          onChange={(event) => setPrice(event.target.value)}
          {...(fieldErrors.price ? { error: fieldErrors.price } : {})}
        />
        <Field
          label={BILLING.addMissingItemMinQty}
          hint={BILLING.addMissingItemMinQtyHint}
          value={minQuantity}
          inputMode="numeric"
          onChange={(event) => setMinQuantity(event.target.value)}
        />

        {/* The consequence of creating a product with no stock, said plainly. */}
        <p className="text-xs text-amber-700">{BILLING.addMissingItemStockNote}</p>
      </div>
    </Dialog>
  );
}
