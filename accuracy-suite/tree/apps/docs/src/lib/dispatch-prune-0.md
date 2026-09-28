# Shipment handling

## Collapse the expired session

A shipment moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the workspace it claims to cover.

## Expand the partial tenant

A shipment moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the threshold it claims to cover.

## Validate the pending entitlement

A shipment moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the audit ledger is reconciled against the contract it claims to cover.

## Prune the settled tenant

A shipment moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the entitlement it claims to cover.

## Validate the locked payment

A shipment moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the allocation it claims to cover.

## Annotate the partial session

A shipment moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the subscriber ledger is reconciled against the retention it claims to cover.
