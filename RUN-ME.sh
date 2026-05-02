#!/bin/bash
set -e

echo "================================================"
echo " Step 1: Push thrive-bot (removes .env from git)"
echo "================================================"
cd ~/thrive-bot
git push
echo "✅ Bot pushed — Railway redeploys automatically"

echo ""
echo "================================================"
echo " Step 2: Push thrive-dashboard to GitHub"
echo "================================================"
cd ~/thrive-dashboard
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/The-AlexBrown/thrive-dashboard.git
git add .
git commit -m "Add deploy scripts" 2>/dev/null || true
git push -u origin main
echo "✅ Dashboard pushed to GitHub"

echo ""
echo "================================================"
echo " Step 3: Install Vercel CLI + deploy"
echo "================================================"
cd ~/thrive-dashboard
npm install -g vercel
vercel --prod --yes \
  -e SUPABASE_URL=https://broxzvtcgkipylohmtdc.supabase.co \
  -e SUPABASE_KEY=sb_secret_lKDRPkspZ-Zn5f8tdV9VdA_gbGk76tJ \
  -e ANTHROPIC_API_KEY=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

echo ""
echo "🎉 All done! Check the URL above for your live dashboard."
