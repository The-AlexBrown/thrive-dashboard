#!/bin/bash
set -e

echo "================================================"
echo " Thrive Dashboard — GitHub + Vercel Deploy"
echo "================================================"
echo ""

cd ~/thrive-dashboard

# ── 1. Create .env (local only, not committed) ────────────────────────────────
cat > .env << 'ENVEOF'
SUPABASE_URL=https://broxzvtcgkipylohmtdc.supabase.co
SUPABASE_KEY=sb_secret_lKDRPkspZ-Zn5f8tdV9VdA_gbGk76tJ
ANTHROPIC_API_KEY=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
ENVEOF

# ── 2. .gitignore ────────────────────────────────────────────────────────────
cat > .gitignore << 'GIEOF'
node_modules/
.env
GIEOF

# ── 3. vercel.json — tells Vercel this is a Node server ──────────────────────
cat > vercel.json << 'VEOF'
{
  "version": 2,
  "builds": [
    { "src": "server.js", "use": "@vercel/node" }
  ],
  "routes": [
    { "src": "/(.*)", "dest": "server.js" }
  ]
}
VEOF

# ── 4. Git init + first commit ───────────────────────────────────────────────
if [ ! -d .git ]; then
  git init
  git branch -M main
fi

git add .
git commit -m "Initial commit - Thrive Dashboard with Supabase" || echo "(nothing new to commit)"

# ── 5. Create GitHub repo via API (no gh CLI needed) ─────────────────────────
echo ""
echo "=== Creating GitHub repo thrive-dashboard ==="
echo "Enter your GitHub personal access token (needs 'repo' scope):"
read -s GITHUB_TOKEN
echo ""

# Create repo under The-AlexBrown org/user
HTTP_CODE=$(curl -s -o /tmp/gh_response.json -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/user/repos \
  -d '{"name":"thrive-dashboard","private":false,"description":"Thrive Bot dashboard with Supabase integration"}')

if [ "$HTTP_CODE" = "201" ]; then
  echo "✅ GitHub repo created!"
elif [ "$HTTP_CODE" = "422" ]; then
  echo "ℹ️  Repo already exists, continuing..."
else
  echo "⚠️  GitHub API returned $HTTP_CODE:"
  cat /tmp/gh_response.json
fi

# Set remote
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/The-AlexBrown/thrive-dashboard.git
git push -u origin main

echo ""
echo "✅ Dashboard pushed to GitHub!"

# ── 6. Install Vercel CLI + deploy ───────────────────────────────────────────
echo ""
echo "=== Installing Vercel CLI ==="
npm install -g vercel 2>&1 | tail -3

echo ""
echo "=== Deploying to Vercel ==="
echo "You'll be prompted to log in to Vercel if not already authenticated."
echo ""

vercel --prod \
  --env SUPABASE_URL=https://broxzvtcgkipylohmtdc.supabase.co \
  --env SUPABASE_KEY=sb_secret_lKDRPkspZ-Zn5f8tdV9VdA_gbGk76tJ \
  --env ANTHROPIC_API_KEY=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 \
  --yes

echo ""
echo "✅ All done! Your dashboard is live on Vercel."
