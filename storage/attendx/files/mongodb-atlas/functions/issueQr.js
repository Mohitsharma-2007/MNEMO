exports = async function(changeEvent) {
  // MongoDB Atlas App Services Function: Issue Dynamic QR Token
  const mongodb = context.services.get("mongodb-atlas");
  const db = mongodb.db("attendx");
  const tokensColl = db.collection("qr_tokens");
  const sessionColl = db.collection("attendance_sessions");
  
  const payload = changeEvent.body ? JSON.parse(changeEvent.body.text()) : changeEvent;
  const session = await sessionColl.findOne({ _id: BSON.ObjectId(payload.sessionId), status: "active" });
  if (!session) {
    return { error: "Session is not active" };
  }
  
  const nonce = Math.random().toString(36).substring(2, 15);
  const expiresAt = new Date(Date.now() + ((session.refresh_interval_s || 15) + 10) * 1000);
  
  const tokenDoc = {
    session_id: payload.sessionId,
    nonce: nonce,
    token: `ATXQR.${payload.sessionId}.${nonce}`,
    expires_at: expiresAt,
    created_at: new Date()
  };
  
  await tokensColl.insertOne(tokenDoc);
  return { token: tokenDoc.token, expiresAt };
};
