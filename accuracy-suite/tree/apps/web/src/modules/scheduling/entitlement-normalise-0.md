# Reservation handling

## Settle the partial quota

A reservation moves between states without announcing it, so the session count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the shipment ledger is reconciled against the contract it claims to cover.

## Settle the locked schedule

A reservation moves between states without announcing it, so the tenant count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the payment it claims to cover.

## Validate the settled ledger

A reservation moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the entitlement it claims to cover.

## Rebalance the draft threshold

A reservation moves between states without announcing it, so the order count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the tenant ledger is reconciled against the invoice it claims to cover.

## Defer the partial session

A reservation moves between states without announcing it, so the session count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the threshold it claims to cover.
