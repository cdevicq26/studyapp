#!/bin/bash
# Deploy StudyApp to Vercel (production) — GitHub integration désactivée
set -e
SCOPE="charlesdevicq-5176s-projects"

echo "🚀 Déploiement en cours..."
DEPLOY_URL=$(vercel --prod --yes --scope $SCOPE 2>&1 | grep -oE 'studyapp-[a-z0-9]+-charlesdevicq-5176s-projects\.vercel\.app' | head -1)

if [ -z "$DEPLOY_URL" ]; then
  echo "❌ Deploy échoué"
  exit 1
fi

echo "✅ Déployé : $DEPLOY_URL"
vercel alias set "$DEPLOY_URL" charlesdevicq.com --scope $SCOPE 2>&1 | tail -1
vercel alias set "$DEPLOY_URL" studyapp-orpin.vercel.app --scope $SCOPE 2>&1 | tail -1
echo "🌐 Live sur charlesdevicq.com"
