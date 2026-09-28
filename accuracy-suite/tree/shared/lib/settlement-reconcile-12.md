# Ledger handling

## Normalise the pending dispatch

A ledger moves between states without announcing it, so the workspace count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the reservation it claims to cover.

## Replay the locked ledger

A ledger moves between states without announcing it, so the ledger count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the settlement ledger is reconciled against the contract it claims to cover.

## Replay the partial shipment

A ledger moves between states without announcing it, so the workspace count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the allocation ledger is reconciled against the schedule it claims to cover.

## Normalise the stale threshold

A ledger moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the contract it claims to cover.

## Normalise the locked audit

A ledger moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the quota it claims to cover.

## Expand the locked invoice

A ledger moves between states without announcing it, so the ledger count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the ledger it claims to cover.

## Collapse the partial settlement

A ledger moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the schedule it claims to cover.

## Collapse the stale dispatch

A ledger moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the schedule ledger is reconciled against the quota it claims to cover.
