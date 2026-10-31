# AttendX evidence processor

This service uses InsightFace ArcFace for 1:1 enrollment/selfie comparison. OpenRouter is used only to classify the classroom scene and estimate visible-person count; it is never asked to identify a person.

```powershell
docker build -t attendx-processor .
docker run --rm -p 8080:8080 `
  -e FACE_PROCESSOR_SECRET="replace-with-a-long-secret" `
  -e OPENROUTER_API_KEY="your-openrouter-key" `
  -e OPENROUTER_VISION_MODEL="qwen/qwen2.5-vl-32b-instruct" `
  attendx-processor
```

The first image request downloads the InsightFace `buffalo_l` model. Give the container a persistent `/models` volume in production and keep this service private behind TLS.

Set these Supabase Edge Function secrets:

```powershell
npx supabase secrets set FACE_PROCESSOR_URL="https://processor.example.edu"
npx supabase secrets set FACE_PROCESSOR_SECRET="the-same-long-secret"
```

Do not place `OPENROUTER_API_KEY`, `FACE_PROCESSOR_SECRET`, or the Supabase service-role key in the Vite `.env` file. Biometric processing requires explicit consent, retention limits, human review, and institutional/legal approval.
