#!/bin/bash
# Plan step 9: the whole reseller chain built from the inside out, one panel per
# tier, then a key from the seller and its due paid upward. Everything the test
# creates is deleted again at the end.
set -u
B=http://localhost:3000
T=$(cygpath -w /tmp)
export T
cd "$(dirname "$0")/.." || exit 1

jar() { echo "$T/chain_$1.txt"; }
login() { rm -f "$(jar $1)"; curl -s -c "$(jar $1)" -o /dev/null -X POST -d "username=$1&password=$2" $B/login; }
# create <caller> <new name>  -> posts through the caller's own panel
create() { curl -s -b "$(jar $1)" -o /dev/null -w "%{http_code}" -X POST \
  --data-urlencode "user_name=$2" --data-urlencode "password=chain123" --data-urlencode "role=$3" $B/add_user; }

echo "=== 1. each tier creates the tier below it, from its own panel"
# What the panel holds before this suite touches anything, handed to the last
# section through the environment. The live database carries the owner's own
# accounts and keys, so "the seed made 7 users and 4 keys" is not the promise to
# keep here — "you get back exactly what you found" is.
export CHAIN_BASE_USERS=$(node -e "const s=require('./db');console.log(s.scalar('SELECT COUNT(*) FROM users'))")
export CHAIN_BASE_KEYS=$(node -e "const s=require('./db');console.log(s.scalar('SELECT COUNT(*) FROM keys'))")
printf '  starting inventory: %s panel(s), %s key(s)\n' "$CHAIN_BASE_USERS" "$CHAIN_BASE_KEYS"
login admin admin123
printf '  controller -> developer            '; create admin CHAINDEV developer; echo
login CHAINDEV chain123
printf '  developer  -> super master admin   '; create CHAINDEV CHAINSM super_master_admin; echo
login CHAINSM chain123
printf '  super master -> master admin       '; create CHAINSM CHAINMA master_admin; echo
login CHAINMA chain123
printf '  master admin -> admin              '; create CHAINMA CHAINAD admin; echo
login CHAINAD chain123
printf '  admin -> super seller              '; create CHAINAD CHAINSUP super_seller; echo
login CHAINSUP chain123
printf '  super seller -> seller             '; create CHAINSUP CHAINSL seller; echo
login CHAINSL chain123

echo
echo "=== 2. creation bills nothing: every fresh panel starts at due 0"
node scripts/check_chain.js dues

echo
echo "=== 3. seller generates a key; every ancestor sees it with the full chain"
curl -s -b "$(jar CHAINSL)" -o /dev/null -w '  POST /generate_key -> %{http_code}\n' -X POST -d "for_id=&days=30&type=normal" $B/generate_key
node scripts/check_chain.js key

echo
echo "=== 4. parent marks the key Paid (the due appears), seller pays, parent accepts"
# Creation no longer raises a due, so the bill comes the real way: CHAINSUP is
# the seller's own parent and marks its key Paid, which charges the seller price.
KEY=$(node -e "const s=require('./db');console.log(s.scalar(\"SELECT id FROM keys WHERE created_by_id=(SELECT id FROM users WHERE username='CHAINSL') ORDER BY id DESC LIMIT 1\"))")
curl -s -b "$(jar CHAINSUP)" -o /dev/null -w '  POST /mark_key_paid -> %{http_code}\n' -X POST -d "key_id=$KEY" $B/mark_key_paid
node scripts/check_chain.js chainbilled
# The amount is the due the seller really carries on this database, not a number
# copied from the seed: role prices are editable on /set_price, and paying less
# than the due would leave a balance rather than clear it.
DUE=$(node -e "const s=require('./db');console.log(s.scalar(\"SELECT due FROM users WHERE username='CHAINSL'\"))")
printf '  seller due                     -> %s\n' "$DUE"
curl -s -b "$(jar CHAINSL)" -o /dev/null -w '  POST /send_payment -> %{http_code}\n' -X POST -d "amount=$DUE" $B/send_payment
curl -s -b "$(jar CHAINSUP)" $B/payment_history -o "$T/ph_chain.html"
node scripts/check_chain.js pending
SENDER=$(node -e "const s=require('./db');console.log(s.scalar(\"SELECT id FROM users WHERE username='CHAINSL'\"))")
curl -s -b "$(jar CHAINSUP)" -o /dev/null -w '  POST /accept_payment -> %{http_code}\n' -X POST -d "sender_id=$SENDER&amount=$DUE" $B/accept_payment
node scripts/check_chain.js settled

echo
echo "=== 5. a tier cannot reach upward or sideways"
# CHAINMA is the parent of CHAINAD, so it is outside CHAINAD's subtree.
printf '  CHAINAD closing its own parent       -> '; curl -s -b "$(jar CHAINAD)" -o /dev/null -w '%{http_code}\n' "$B/status_update?u_id=$(node -e "const s=require('./db');console.log(s.scalar(\"SELECT id FROM users WHERE username='CHAINMA'\"))")"
printf '  CHAINAD opening /set_price          -> '; curl -s -b "$(jar CHAINAD)" -o /dev/null -w '%{http_code}\n' $B/set_price
printf '  CHAINAD deleting CHAINDEV (not his) -> '; curl -s -b "$(jar CHAINAD)" -o /dev/null -w '%{http_code}\n' -X POST -d "root_id=$(node -e "const s=require('./db');console.log(s.scalar(\"SELECT id FROM users WHERE username='CHAINDEV'\"))")" $B/delete_user_cascade
node scripts/check_chain.js blocked

echo
echo "=== 6. controller cascades the whole branch away"
DEV=$(node -e "const s=require('./db');console.log(s.scalar(\"SELECT id FROM users WHERE username='CHAINDEV'\"))")
curl -s -b "$(jar admin)" -o /dev/null -w '  POST /delete_user_cascade -> %{http_code}\n' -X POST -d "root_id=$DEV" $B/delete_user_cascade
node scripts/check_chain.js cleaned
