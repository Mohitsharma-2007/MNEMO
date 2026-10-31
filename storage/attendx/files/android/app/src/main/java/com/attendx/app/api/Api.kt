package com.attendx.app.api

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class ApiResult(val ok: Boolean, val status: Int, val body: String) {
    fun json(): JSONObject = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
    fun jsonArray(): JSONArray = try { JSONArray(body) } catch (_: Exception) { JSONArray() }
    fun errorMessage(): String =
        json().optString("error").ifEmpty { "Request failed ($status)" }
}

class ApiException(message: String) : Exception(message)

class Api(private val context: Context) {

    private val prefs = context.getSharedPreferences("attendx_server", Context.MODE_PRIVATE)
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    var serverUrl: String
        get() = prefs.getString("server_url", DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(value) { prefs.edit().putString("server_url", value.trimEnd('/')).apply() }

    fun token(): String? = context.getSharedPreferences("attendx_session", Context.MODE_PRIVATE)
        .getString("token", null)

    suspend fun request(
        path: String,
        method: String = "GET",
        body: JSONObject? = null,
        auth: Boolean = true,
        query: Map<String, String> = emptyMap(),
    ): ApiResult = withContext(Dispatchers.IO) {
        val url = buildString {
            append(serverUrl).append(path)
            if (query.isNotEmpty()) {
                append('?')
                append(query.entries.joinToString("&") { (k, v) ->
                    k + "=" + java.net.URLEncoder.encode(v, "UTF-8")
                })
            }
        }
        val builder = Request.Builder().url(url)
        if (body != null) {
            builder.method(method, body.toString().toRequestBody("application/json".toMediaType()))
        } else {
            builder.method(method, null)
        }
        if (auth) {
            token()?.let { builder.header("Authorization", "Bearer $it") }
        }
        builder.header("Accept", "application/json")
        try {
            client.newCall(builder.build()).execute().use { res ->
                ApiResult(res.isSuccessful, res.code, res.body?.string() ?: "")
            }
        } catch (e: Exception) {
            ApiResult(false, 0, """{"error":"${e.message ?: "network error"}"}""")
        }
    }

    private suspend fun requireOk(result: ApiResult, what: String): JSONObject {
        if (!result.ok) throw ApiException(result.errorMessage())
        return result.json()
    }

    // ── Auth ────────────────────────────────────────────────────────────
    suspend fun login(email: String, password: String): Pair<String, JSONObject> {
        val res = requireOk(
            request("/api/auth/login", "POST", JSONObject().put("email", email.trim().lowercase()).put("password", password), auth = false),
            "Sign in"
        )
        val token = res.optString("access_token")
        if (token.isEmpty()) throw ApiException("Sign in failed")
        val profile = res.optJSONObject("profile") ?: JSONObject()
        return token to profile
    }

    suspend fun sendOtp(email: String, purpose: String) {
        requireOk(
            request("/api/auth/send-otp", "POST", JSONObject().put("email", email).put("purpose", purpose), auth = false),
            "Send verification"
        )
    }

    suspend fun resetPassword(email: String, code: String, newPassword: String) {
        requireOk(
            request(
                "/api/auth/reset-password",
                "POST",
                JSONObject().put("email", email).put("code", code).put("newPassword", newPassword),
                auth = false
            ),
            "Reset password"
        )
    }

    // ── Health / catalog ────────────────────────────────────────────────
    suspend fun health(): JSONObject =
        request("/api/health", auth = false).let { it.json() }

    suspend fun catalog(): JSONObject = requireOk(request("/api/notices/catalog"), "Mail Center")

    // ── Mail Center ─────────────────────────────────────────────────────
    suspend fun raiseNotice(type: String, subject: String, message: String, audience: String? = null, targetEmail: String? = null): JSONObject {
        val body = JSONObject()
            .put("type", type)
            .put("subject", subject)
            .put("message", message)
        audience?.let { body.put("audience", it) }
        targetEmail?.let { body.put("targetEmail", it) }
        return requireOk(request("/api/notices", "POST", body), "Send request")
    }

    suspend fun listNotices(status: String? = null, trackingId: String? = null): JSONArray {
        val q = mutableMapOf<String, String>()
        status?.let { q["status"] = it }
        trackingId?.let { q["trackingId"] = it }
        val res = request("/api/notices", query = q)
        return if (res.ok) res.jsonArray() else JSONArray()
    }

    suspend fun resolveNotice(id: String, status: String, note: String): JSONObject =
        requireOk(
            request("/api/notices/$id", "PATCH", JSONObject().put("status", status).put("adminNote", note)),
            "Update request"
        )

    suspend fun directory(): JSONArray {
        val res = request("/api/admin/directory")
        return if (res.ok) res.json().optJSONArray("users") ?: JSONArray() else JSONArray()
    }

    // ── Dashboard data ──────────────────────────────────────────────────
    suspend fun studentSummary(): JSONArray {
        val res = request("/api/data/student_attendance_summary")
        return if (res.ok) res.jsonArray() else JSONArray()
    }

    suspend fun classes(facultyId: String? = null): JSONArray {
        val q = mutableMapOf<String, String>()
        facultyId?.let { q["faculty_id"] = "eq.$it" }
        val res = request("/api/data/classes", query = q)
        return if (res.ok) res.jsonArray() else JSONArray()
    }

    // ── Faculty session ─────────────────────────────────────────────────
    suspend fun startSession(
        classId: String,
        latitude: Double,
        longitude: Double,
        intervalSeconds: Int,
    ): JSONObject = requireOk(
        request(
            "/api/functions/start-session",
            "POST",
            JSONObject()
                .put("classId", classId)
                .put("refreshIntervalSeconds", intervalSeconds)
                .put("latitude", latitude)
                .put("longitude", longitude)
        ),
        "Start session"
    ).optJSONObject("session") ?: throw ApiException("No session returned")

    suspend fun issueQr(sessionId: String): String {
        val res = requireOk(
            request("/api/functions/issue-qr", "POST", JSONObject().put("sessionId", sessionId)),
            "Issue QR"
        )
        return res.optString("token").ifEmpty { throw ApiException("Empty QR token") }
    }

    suspend fun roster(sessionId: String): JSONArray {
        val res = request("/api/data/attendance_records", query = mapOf("session_id" to "eq.$sessionId"))
        return if (res.ok) res.jsonArray() else JSONArray()
    }

    // ── Student mark ────────────────────────────────────────────────────
    suspend fun submitAttendance(
        token: String,
        latitude: Double,
        longitude: Double,
        accuracy: Float,
        selfieBase64: String,
    ): JSONObject = requireOk(
        request(
            "/api/functions/submit-attendance",
            "POST",
            JSONObject()
                .put("token", token)
                .put("location", JSONObject().put("latitude", latitude).put("longitude", longitude).put("accuracy", accuracy))
                .put("selfieDataUrl", selfieBase64)
                .put("selfieCapturedAt", System.currentTimeMillis())
                .put("device", JSONObject().put("platform", "android-native").put("uuid", deviceUuid()))
        ),
        "Mark attendance"
    )

    private fun deviceUuid(): String {
        val sp = context.getSharedPreferences("attendx_server", Context.MODE_PRIVATE)
        var id = sp.getString("device_uuid", null)
        if (id == null) {
            id = java.util.UUID.randomUUID().toString()
            sp.edit().putString("device_uuid", id).apply()
        }
        return id
    }

    companion object {
        const val DEFAULT_SERVER = "https://attendx-lilac-zeta.vercel.app"
    }
}