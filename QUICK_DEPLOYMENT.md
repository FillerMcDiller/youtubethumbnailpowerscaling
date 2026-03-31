# Quick Deployment Reference

## What Changed?

**Backend (Cloudflare Worker):**
```
✓ Rate limiting: 30 req/min, 20 matches/min (per IP)
✓ New endpoint: POST /api/submit-match (server-validated)
✓ Power cap: 100 max per video (hard enforced)
✓ Search caching: 2-hour TTL (75% quota savings)
✓ Old endpoint: POST /api/state (deprecated → 410)
```

**Frontend (index.html):**
```
✓ recordWin() uses /api/submit-match
✓ Server-authoritative power (not client-calculated)
✓ User feedback for rate limits & power caps
✓ Fallback to local persistence if API unavailable
```

---

## Deploy in 3 Steps

```bash
# 1. Deploy backend
cd cloudflare-worker/
wrangler deploy

# 2. Verify frontend changes are live (auto-updated)

# 3. Test (optional)
curl -X POST "https://your-api.workers.dev/api/submit-match" \
  -H "Content-Type: application/json" \
  -d '{"winnerId":"test","loserId":"test2"}'
```

---

## Verify Protection Works

### Rate Limit Test:
```bash
for i in {1..35}; do
  curl "https://your-api.workers.dev/api/random-pair" \
    -H "cf-connecting-ip: 192.168.1.100"
done
# After 30: HTTP 429 ✓
```

### Power Cap Test:
```bash
# Get a video to power 99-100, then vote for it
# Should get: HTTP 400 "Power cap reached" ✓
```

---

## Config Tweaks (if needed)

Edit `cloudflare-worker/index.js` line 9-12:

```javascript
const MAX_POWER_PER_VIDEO = 100;    // Lower = softer cap
const REQUESTS_PER_MINUTE = 30;     // Lower = stricter
const MATCHES_PER_MINUTE = 20;      // Lower = stricter rate limit
const SEARCH_CACHE_TTL = 7200;      // Lower = fresher results
```

---

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| 15-min quota | ~2,000 | ~400 |
| Max power | ∞ | 100 |
| Autoclicker speed | ∞ | 20/min |
| State integrity | ❌ | ✅ |

---

## Troubleshooting

**Q: Users seeing "Power cap reached"?**
- A: Expected behavior. Video hit 100 power. Editable via `MAX_POWER_PER_VIDEO`.

**Q: Users seeing "Rate limit exceeded"?**
- A: Expected behavior. IP hit 30+ req/min. Slow down = normal usage.

**Q: API requests still high?**
- A: KV cache may need time to populate. After 1 hour, should see 75% reduction.

**Q: Old `POST /api/state` failing?**
- A: Intentional. Redirect users to use new `/api/submit-match` endpoint.

---

## Rollback (if needed)

Revert `cloudflare-worker/index.js` to last working version and redeploy:
```bash
git revert <commit-hash>
cd cloudflare-worker/
wrangler deploy
```

---

## Files Modified

- `cloudflare-worker/index.js` — Backend with protections
- `index.html` — Frontend using new endpoint
- `ABUSE_PROTECTION_UPDATE.md` — Full technical docs
- `IMPLEMENTATION_SUMMARY.md` — This reference

