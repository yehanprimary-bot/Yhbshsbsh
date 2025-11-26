# yehazz-md-pairing

Pairing website + backend for Yehazz MD WhatsApp bot (dark theme).
This repo contains frontend (Next.js) and backend (Node.js + Baileys) code.

IMPORTANT:
- Backend must run on a persistent server (VPS, Render private service, etc.).
- Do NOT commit auth/ or .env values to GitHub.
- See backend/.env.example for required env vars.

Deploy:
- Frontend: push `frontend/` to GitHub and deploy to Vercel. Set NEXT_PUBLIC_BACKEND to your backend URL.
- Backend: run `backend/server.js` on a VPS and ensure HTTPS + persistent auth folder.

