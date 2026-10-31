exports = async function(changeEvent) {
  // MongoDB Atlas App Services Function: Submit Attendance
  // Triggers when a student submits their signed QR token, geofence coordinates, and photo evidence
  const mongodb = context.services.get("mongodb-atlas");
  const db = mongodb.db("attendx");
  const attendanceColl = db.collection("attendance_records");
  const sessionColl = db.collection("attendance_sessions");
  
  const payload = changeEvent.body ? JSON.parse(changeEvent.body.text()) : changeEvent;
  
  // Verify active session
  const session = await sessionColl.findOne({ _id: BSON.ObjectId(payload.sessionId), status: "active" });
  if (!session) {
    return { error: "Session not active or not found" };
  }
  
  // Calculate distance (Haversine formula in MongoDB Atlas function)
  const R = 6371000;
  const dLat = ((payload.location.latitude - session.center_lat) * Math.PI) / 180;
  const dLon = ((payload.location.longitude - session.center_lng) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((session.center_lat * Math.PI) / 180) *
            Math.cos((payload.location.latitude * Math.PI) / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const isInside = distance <= (session.geofence_radius_m || 50);
  
  const status = isInside ? "present" : "rejected";
  const record = {
    session_id: payload.sessionId,
    student_id: payload.studentId,
    gps_lat: payload.location.latitude,
    gps_lng: payload.location.longitude,
    distance_m: distance,
    status: status,
    rejection_reason: isInside ? null : "Outside geofence",
    created_at: new Date()
  };
  
  await attendanceColl.insertOne(record);
  return { success: true, record };
};
