// SPDX-License-Identifier: AGPL-3.0-or-later

package probe

import "sync"

// Reorder hands results on in the order the probes were sent. Probes run on a
// fixed schedule and overlap while a target is slow or timing out, so they
// finish out of order: result n is held back until 1..n-1 have been delivered.
// Every probe ends within its timeout, so nothing is held longer than that.
type Reorder struct {
	mu      sync.Mutex
	next    uint64
	waiting map[uint64]Result
	deliver func(Result)
}

func NewReorder(deliver func(Result)) *Reorder {
	return &Reorder{next: 1, waiting: map[uint64]Result{}, deliver: deliver}
}

// Push accepts the result of probe number seq (counted from 1). deliver is
// called with the lock held, so deliveries never overlap.
func (o *Reorder) Push(seq uint64, r Result) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.waiting[seq] = r
	for {
		r, ok := o.waiting[o.next]
		if !ok {
			return
		}
		delete(o.waiting, o.next)
		o.next++
		o.deliver(r)
	}
}
