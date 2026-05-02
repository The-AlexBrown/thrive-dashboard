#!/bin/bash
# Run this once to push thrive-dashboard to GitHub + install Vercel + deploy
cd ~/thrive-dashboard

# Wire up the GitHub remote
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/The-AlexBrown/thrive-dashboard.git

# Stage all files and push
git add .
git commit -m "Initial commit - Thrive Dashboard with Supabase" 2>/dev/null || echo "Nothing new to commit"
git push -u origin main

echo ""
echo "✅ Pushed to GitHub!"
echo ""
echo "Now installing Vercel CLI and deploying..."
npm install -g vercel
vercel --prod --yes \
  -e SUPABASE_URL=https://broxzvtcgkipylohmtdc.supabase.co \
  -e SUPABASE_KEY=sb_secret_lKDRPkspZ-Zn5f8tdV9VdA_gbGk76tJ \
  -e ANTHROPIC_API_KEY=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
