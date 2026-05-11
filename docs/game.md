# trader — the game

A buy-low / sell-high trading game set in a living 1980s south-London
high street. You play one of about twenty named characters going about
their week. Everyone else is doing the same thing on their own clock
whether you watch them or not. The world ticks one hour at a time,
seven days a week, with auctions, pub haggling, market stalls, gossip,
heat from the law, and a finite amount of stock moving around between
people who all have somewhere to be.

This document describes the game as it plays. The engine internals
that produce it live in [design.md](design.md).

## The premise

A van turns up in Peckham with a hundred fair-condition radios at
£8 a pop. By Thursday you need £200 for the lockup rent and a wholesaler
in Lewisham has hinted he might take twenty Hi-Fis off your hands at
£40 each — but only if you can get them across the river before he
shuts up shop. Boycie reckons he's got a line on a furniture haul
and would split a finder's fee. Trigger heard about the radios in the
pub and is telling anyone who'll listen that they're actually
*televisions*, at £15. Sotheby's auction starts at ten.

That's the texture. You have time, cash, a vehicle with finite
capacity, an inventory, a reputation, and a notebook of half-true
rumours. So does everyone else.

## What you do

The fundamental loop:

1. **Find stock.** A pool opens — someone needs to shift 100 of
   something at a wholesale price. You hear about it from the
   proprietor of wherever you happen to walk in, from another dealer
   at the bar, or from the newspaper if it's been listed for auction.
2. **Acquire it.** Either claim from the pool directly (if you know
   about it and have cash and capacity), buy it off another dealer in
   a pub haggle, or bid for it at Sotheby's.
3. **Move it.** A market stall on Saturday, a shop on the high street
   that specialises in your category, a private deal in the Nag's,
   the off-map auction whales for anything that won't shift locally,
   or back to the auction house if you're desperate.
4. **Don't get caught holding the bag.** Stock decays in usefulness,
   deadlines on forward-sold deals don't move, heat accumulates if
   you're conspicuous, and the lockup rent is on Friday.

You decide each hour where to be. Co-location is the gate to almost
every interaction — if you're not in the room you can't make the
deal, hear the gossip, or bid on the lot.

## The world

**Peckham and surrounds.** A small map of named locations:

- **Homes** — Del's flat, Boycie's, Denzil's, Trigger's, Cassandra's,
  Mickey & Jevon's, Raquel's, Alan Parry's, Slater's.
- **Pubs** — the Nag's Head (the centre of trade), the 111 Club, the
  Starlight Rooms, the Shamrock Club, the Royal British Legion.
- **Trade venues** — Peckham Market, Sotheby's auction house,
  Boycie Autos, Transworld Depot, the council yard.
- **Civic** — the Nick (police station), Post Office, the Bookies.
- **Cafés and shops** — Sid's Café (the gossip exchange), Goldfingers,
  Ratners of Peckham, Patel's Newsagent, the Corner Shop, Wooden
  Soldier, Toyland, Sparks Electrical, Hi-Tech Hut, Comfy Corner,
  Throne & Co, Dirty Barry's, Parry Print, Cassandra's bank.
- **Off-map** — an abstract node where regional dealers, wholesalers,
  and auction whales live.

Each venue has its own opening hours and days of the week. The pubs
keep different hours than the bank. Sotheby's runs Mon–Fri.
Half the high-street shops shut on Saturday afternoon. When a place
is closed, the chip dims everywhere in the UI — you can see it but
not enter.

**Time.** The clock advances in 1-hour ticks. A run is normally 14
days. Each day every actor's routine fires their LEAVE → ARRIVE
movements, then INTERACT happens with everyone in place, then the
hour ends. Weekends shift behaviour: shops close, the auction goes
quiet, market footfall changes.

## The cast

A handful of named characters with distinct profiles, routines, and
purposes in the world. You can step into any of them.

| Character | Role |
|-----------|------|
| **Del Boy** (player default) | Generalist dealer, a flat, a lockup, a van, perpetual short cash. |
| **Rodney Trotter** | Younger sibling / sidekick; lower cash, lower confidence. |
| **Uncle Albert / Grandad** | Around the flat; opinions; little capital. |
| **Boycie** | Sharp middleman, owns Boycie Autos, lives well. Specialises in vehicles and high-margin gear. |
| **Marlene Boyce** | Boycie's other half; furniture-shop adjacent. |
| **Trigger** | Council yard sweeper; broad routes, low information accuracy, but he's *everywhere*. Plays a key gossip-spreading role precisely because he gets it wrong. |
| **Denzil** | Driver, regional contact, mobile information-trader. |
| **Mike Fisher** | Publican at the Nag's. Information-trader: the bar is the exchange. |
| **Sid** | Café owner. Information-trader: the café is where the morning newspapers and morning gossip land. |
| **Mickey Pearce, Jevon** | Junior dealers. Cheap stock, ambitious, prone to mistakes. |
| **Monkey Harris** | Off-map fence with a route into south London. |
| **Cassandra Parry** | Bank, weekday office hours, lunch elsewhere — a different texture of routine entirely. |
| **Alan Parry** | Prints, suburban routine. |
| **Raquel Turner** | Social circle around Del. |
| **DCI Roy Slater** | The law. Conducts authority sweeps when heat is up. |
| **Dirty Barry** | Adult-shop proprietor, niche specialty. |
| **Eugene McCarthy** | Solicitor / fixer character. |
| **Off-map dealers** | Named whales with their own appetites — wholesalers and resellers who travel in to bid at Sotheby's or take stock off your hands at the boundary. |
| **Shopkeepers** | One per high-street shop, each with a category specialty (furniture, electronics, jewellery, toys, etc). |

Any of them is a viable point-of-view. Take over Boycie and you've got
his cash, his car-lot routine, his shop, his reputation among the
dealers, his contacts. Take over Trigger and you've got broad foot
access to half the locations, almost no cash, and the unique role of
seeing everything and remembering most of it wrong.

## Resources you manage

- **Cash.** Single balance. Conserved across the world — you can only
  end up with someone else's money if they ended up with less. The
  one exception is the boundary node (auction proceeds, off-map
  resale, fines, fees) which conceptually represents the rest of the
  economy.
- **Inventory.** Stock lots in your bag, your home, or your lockup.
  Each lot has a kind, quality tier (poor / fair / good / mint),
  optional flaws, and a known acquisition cost.
- **Transport capacity.** What you can carry / drive at once.
  Inherent to the character — a barrow is not a van.
- **Time.** 24 hours a day, but the meaningful slice is the
  awake/in-public hours of your routine. Some hours are slotted
  (work, bedtime); some are FLEXIBLE, and those are when you choose.
- **Knowledge.** A personal ledger of leads about stock pools and
  about other people's reputations. Each lead has a confidence, a
  hop count, an immediate prior speaker, and an age in days.
  Knowledge decays.
- **Trust.** A counter held *by other actors about you*. Drops when
  you walk away from a deal, default on a delivery, or get caught.
  Affects whether they'll engage next time.
- **Heat.** A counter on you held by the law. Rises with
  conspicuous activity; decays day by day; high enough triggers an
  authority sweep.

## Actions and their hour cost

Co-location is necessary but not sufficient — interaction takes time.

| Action | Hour cost | Effect |
|--------|-----------|--------|
| Enter a location | passive | Drive-by gossip exchange with the proprietor (1 lead each way). |
| Try a deal with someone in the room | 1 hour | A full negotiation — opens, offers, counters, agreed or walked. Both sides also share a deal-adjacent lead at the end. |
| Have a chat with someone in the room | 1 hour | Up to 3 new leads each way, plus up to 4 clarification queries (you ask them about a specific subject; they tell you what *they* heard). |
| Read the morning paper at a newsagent or café | passive | Adds the day's Sotheby's docket to your knowledge. |
| Inspect a lot at the auction gallery | 1 hour | Unlocks flaw spotting — refines your retail estimate before the gavel. |
| Run a market stall | hourly | Sells through customer footfall against persona histograms. |
| Bid at auction | per-lot | Bidder behaviour driven by your retail estimate, your customer base, and your appetite. |

The evening at the Nag's becomes a decision tree: with three flexible
hours and six people in the room, who do you spend each hour with?
Mike (publican, info-trader) is high yield for leads. Boycie is high
yield for deals if you have stock he wants. Trigger is comic relief
that occasionally drops gold by accident.

## Stock pools — where supply comes from

A *pool* is a chunk of stock that's available to claim at a wholesale
price for a limited window. New pools open daily from a catalogue of
about fifty everyday items (radios, jeans, watches, kettles,
furniture) and about thirty-seven rare easter-egg items with show
flavour. Each pool has:

- A quantity, item kind, tier, and unit price.
- An opening fraction (how much of retail the wholesale is — typically
  around 25%).
- A reachability set — which actors can plausibly source it. A
  furniture pool reaches the dealers and shopkeepers who know furniture;
  it doesn't reach Cassandra at the bank.
- A closing day. After that day the pool is gone, flushed to the
  off-map market, or rolled into Sotheby's as a regional clearance lot.

You learn about a pool by gossip. The first lead is the proprietor
of wherever the pool's "story" emerged — and that lead is true.
By the time it's hopped through three speakers it might claim 120
items where there were 80, or fair-tier where it was good-tier, or
on rare occasions the buyer and seller might be swapped.

You claim from a pool by going to the right counterparty (whichever
named external producer owns it) with cash. Once claimed, the pool's
remaining quantity drops, and other dealers' leads about it start
showing stale numbers.

## Forward deals

A *deal* is a contract: "I will deliver N units of X at price Y by
day Z." Unlike a pool claim, deals can be struck for stock you don't
own yet. The clock is the pressure. Default and your trust with the
counterparty drops and you take a reputation hit that spreads through
gossip.

## Negotiation

Pub deals, shop sales, and market stalls all share one negotiation
engine. Each side has a private valuation derived from:

- The retail estimate (a band around true retail, narrowed by their
  expertise and inspection access).
- Their customer base (a shopkeeper who specialises in furniture
  values a desk higher than a generalist would).
- Their cash position and inventory pressure.
- The trust they hold in you, and the rep leads they've heard.

The negotiation plays out as a turn sequence — opens, counters,
walkaways — and the full sequence is preserved in the event stream
so the UI can replay it. You can step through any deal that's ever
happened, watch the offers, and see why someone walked.

## The auction

Sotheby's runs an open-cry English auction one lot per hour during
the auction window on weekdays. Lots come from two sources:

- **Local clearance** — pools that didn't sell privately get rolled in.
- **Regional clearance** — an external schedule that runs every
  auction-open day independently, so the docket is never empty.

Bidders are everyone physically present in the auction house who
knows about the lot (from the newspaper docket, prior gallery
inspection, or word of mouth). Each bidder has a customer profile,
an appraisal accuracy, and a budget. Whales travel in from off-map
to clear the heavyweight lots.

Knowing about a lot doesn't mean you'll engage — bidders only chase
lots that score well against their customer base. Specialising your
inventory pulls your dealer more strongly toward Sotheby's when their
category appears.

## The information game

This is the layer that gives the game most of its texture. Two kinds
of leads circulate:

- **Commodity leads** — *Someone has 100 fair radios at £8 / Someone
  needs Hi-Fis*.
- **Reputation leads** — *Boyce stitched Trigger on a watch deal,
  £300 damage*.

Both flow through the same hop / confidence / decay machinery. Both
mutate when retold:

- Numbers drift (±jitter on quantity and price every hop).
- Tiers occasionally slip (good → fair).
- Rarely but catastrophically, roles flip — buyer and seller swap on
  a commodity lead; victim and perpetrator swap on a rep lead.

The mutation is per-hop, so Mickey can keep peddling the wrong story
about Boyce burning Trigger for as long as nobody corrects him. You
correct it by walking the chain — *clarify with Trigger* — and your
ledger then carries both versions, with the immediate prior speaker
recorded so you can verify further back.

**Information-traders** — Denzil, Mike, Sid, Albert — have outsized
lead capacity per encounter and a location-flavoured slant. The
value of those characters is the conversation, not the stock.

**Rep leads gate behaviour.** A warm enough rep lead about you (recent,
short hop count, high damage) above a threshold causes the would-be
buyer to walk away from a deal before negotiation even starts. The
event surfaces as `pubdeal.skipped-rep` so you can see exactly which
piece of gossip cost you the sale.

## Heat and the law

Conspicuous activity — auction wins, large pool claims, repeated
deals out of the same lockup — accrues heat. Heat decays day by day.
A daily authority sweep checks the hottest actors against a
threshold; over it, you get raided. The mechanic is event-driven
(`heat-reactions.ts`, `authority-sweep.ts`), so any action that
should attract attention can be wired in.

DCI Slater is the personification — his routine includes the Nick.
A raid takes time off your day and can confiscate stock.

## Playing someone other than Del

The engine treats every actor identically. Each has:

- A routine (some slots fixed — work, sleep — some FLEXIBLE).
- A home, a cash balance, transport capacity.
- A bidder profile (customer base, appraisal accuracy).
- A specialty (if a shopkeeper) or a slant (if an info-trader).
- A reputation, a knowledge ledger, an inventory.

Take over Boycie and your routine starts pulling you toward the
car lot weekday mornings. Your cash is higher. Your appraisal is
sharper for vehicles than for jewellery. Marlene at home holds half
your social contact. Your gossip slant means dealers come to you
hoping for a finder's fee on a specific kind of haul. The auction
sees you differently because your customer base is different. The
furniture pools route to you reliably; the cassette pools don't.

Take over Trigger and the entire game changes shape. You don't have
cash to claim pools, so your trade is information arbitrage — knowing
something Mickey doesn't, selling the tip for a small cut, or moving
one or two items at a time on foot. Your accuracy is poor enough that
half your tips are wrong; the comedy is that some of the wrong ones
turn out to be more valuable than the right ones.

Take over Cassandra and you're an outsider to the dealer economy —
your knowledge ledger fills up with rep leads about Del's circle that
the dealers themselves never get to hear. You can choose to use any
of it.

## A representative Tuesday

A texture of one day, played as Del:

- **08:00** Wake at the flat. Rodney's already gone to whatever he's
  pretending to do. Grandad makes tea.
- **09:00** Walk down to Sid's. Read the paper — Sotheby's has a lot
  of 30 fair watches at 11am. Sid mentions Denzil was in earlier
  asking about Hi-Fis. Note that.
- **10:00** Over to the lockup. Inventory: 14 fair radios from
  Saturday's pool, 3 toasters, a box of jeans. Cash: £340.
- **11:00** Sotheby's gallery — inspect the watches. One has a
  cracked back; your retail estimate drops £4 per unit.
- **12:00** Bid on the watches. Boycie's there. He outbids you on
  the watches but you pick up the next lot, a job of 20 fair kettles
  at £6, cheap enough to flip at Comfy Corner.
- **13:00** Lunch at Sid's. Mike Fisher's in for a sandwich — chats
  for an hour, you come away with three leads, one of which says
  Monkey Harris is shifting Hi-Fis at £18 wholesale tomorrow.
- **14:00** Walk to Comfy Corner — try a deal on the kettles. The
  shopkeeper's customer base is wrong; he walks at £8/unit.
- **15:00** Toyland — kettles still wrong category. No deal.
- **16:00** Sparks Electrical — right category. Agreed at £11/unit.
  £220 in, capacity freed.
- **17:00** Back to the lockup, drop off the new watches.
- **19:00** Nag's Head. Boycie's at the bar. Try a deal on the watches:
  he's got a buyer, offers £14/unit, you wanted £18, walks. Both of
  you take a 1-lead exchange on the way out — and Boycie now has a
  bag-of-leads claim that Del was sitting on cracked-back watches.
- **20:00** Have a chat with Mike — clarify the Monkey-Harris lead.
  Mike's version says £15 not £18. Your ledger now carries both.
- **22:00** Home.

That's a normal day. Wednesday you'll go and find Monkey before
anyone else does, because you have a £15 lead and a £18 lead and
strong odds the truth is between them.

## Run lengths and seeds

A standard run is 14 days. The seed determines pool spawns, jitter,
appraisal noise, and customer histograms — so two runs at the same
seed produce identical events. This is for debugging and replay; in
play the seed is just whatever you choose to start with.

## Where to look in the UI

- **Map** — see who's where right now, with closed venues dimmed.
- **Events** — the world's narration: gossip, deals, pool flushes,
  raids, auction lots.
- **Inventory** — your stock and everyone else's (omniscient in dev;
  scope-limited in play).
- **Deals** — forward contracts and their deadlines.
- **Pools** — what's open, who knows about it, what's been claimed.
- **Sidebar → Actor → Knows** — the personal ledger. Timeline / By
  item / By person views, with divergent values highlighted and the
  source chain shown for each fact.
- **Sidebar → Actor → Diary** — every event that mentions this
  actor, ordered.
- **Sidebar → Actor → Profile** — cash, inventory, trust matrix,
  heat, routine.

## A note on the skin

The character names, locations, items, and flavour above are *Only
Fools and Horses*. The engine never references the show — every name
above is content data in `src/skins/placeholder/`. Swapping the
skin folder produces a different setting (the intended second skin
is *Minder*) with the same mechanics underneath. Build your own
skin and the game is whatever village, market town, or fantasy port
you populate it with — as long as it has someone selling something
to someone else for less than it's worth.
