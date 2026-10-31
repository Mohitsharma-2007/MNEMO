package com.attendx.app.api

import android.content.Context
import org.json.JSONObject

data class Session(
    val token: String,
    val userId: String,
    val email: String,
    val role: String,
    val fullName: String,
    val identifier: String,
    val department: String,
    val approvalStatus: String,
)

class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("attendx_session", Context.MODE_PRIVATE)

    fun save(token: String, profile: JSONObject, user: JSONObject?) {
        val userId = profile.optString("id").ifEmpty { user?.optString("id").orEmpty() }
        val role = profile.optString("role").ifEmpty { user?.optString("role").orEmpty() }
        prefs.edit()
            .putString("token", token)
            .putString("user_id", userId)
            .putString("email", profile.optString("email"))
            .putString("role", role)
            .putString("full_name", profile.optString("full_name"))
            .putString("identifier", profile.optString("identifier"))
            .putString("department", profile.optString("department"))
            .putString("approval_status", profile.optString("approval_status"))
            .apply()
    }

    fun load(): Session? {
        val token = prefs.getString("token", null) ?: return null
        return Session(
            token = token,
            userId = prefs.getString("user_id", "") ?: "",
            email = prefs.getString("email", "") ?: "",
            role = prefs.getString("role", "") ?: "",
            fullName = prefs.getString("full_name", "") ?: "",
            identifier = prefs.getString("identifier", "") ?: "",
            department = prefs.getString("department", "") ?: "",
            approvalStatus = prefs.getString("approval_status", "") ?: "",
        )
    }

    fun clear() {
        prefs.edit().clear().apply()
    }
}