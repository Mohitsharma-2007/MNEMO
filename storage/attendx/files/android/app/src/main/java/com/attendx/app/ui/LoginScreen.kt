package com.attendx.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.attendx.app.api.Api
import com.attendx.app.api.ApiException
import kotlinx.coroutines.launch
import org.json.JSONObject

private val roles = listOf("student" to "Student", "faculty" to "Faculty", "admin" to "Admin")

@Composable
fun LoginScreen(api: Api, onSignedIn: (String, JSONObject) -> Unit) {
    val scope = rememberCoroutineScope()
    var role by remember { mutableStateOf("student") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    var resetMode by remember { mutableStateOf(false) }
    var otpSent by remember { mutableStateOf(false) }
    var otpCode by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }

    fun signIn() {
        scope.launch {
            loading = true; error = null
            try {
                val (token, profile) = api.login(email, password)
                onSignedIn(token, profile)
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Exception) {
                error = "Could not reach the AttendX server"
            }
            loading = false
        }
    }

    fun sendOtp() {
        scope.launch {
            loading = true; error = null
            try {
                api.sendOtp(email, "password_reset")
                otpSent = true
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Exception) {
                error = "Could not reach the AttendX server"
            }
            loading = false
        }
    }

    fun completeReset() {
        scope.launch {
            loading = true; error = null
            try {
                if (newPassword.length < 12) throw ApiException("Use at least 12 characters")
                if (newPassword != confirmPassword) throw ApiException("Passwords do not match")
                api.resetPassword(email, otpCode, newPassword)
                error = "Password updated — sign in with your new password."
                resetMode = false; otpSent = false
                password = ""; newPassword = ""; confirmPassword = ""; otpCode = ""
            } catch (e: ApiException) {
                error = e.message
            }
            loading = false
        }
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(24.dp))
            Text("AttendX", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.primary)
            Text("VERIFIED PRESENCE", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(28.dp))

            if (!resetMode) {
                Text("Choose a workspace and sign in with your institution account.", style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(16.dp))

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    roles.forEach { (key, label) ->
                        Card(
                            onClick = { role = key },
                            colors = CardDefaults.cardColors(
                                containerColor = if (role == key) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
                            ),
                        ) {
                            Column(
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Text(label, style = MaterialTheme.typography.titleSmall)
                                Text(
                                    when (key) {
                                        "student" -> "Mark and track attendance"
                                        "faculty" -> "Run classroom sessions"
                                        else -> "Manage institution access"
                                    },
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.height(20.dp))
            } else {
                Text("Request a password reset", style = MaterialTheme.typography.titleLarge)
                Text("An OTP will be emailed to you via Gmail SMTP.", style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(16.dp))
            }

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 10.dp))
            }

            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("Institution email") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))

            if (!resetMode) {
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = { resetMode = true; error = null }) { Text("Forgot password?") }
                }
            } else if (!otpSent) {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Institution email") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(16.dp))
            } else {
                OutlinedTextField(
                    value = otpCode,
                    onValueChange = { otpCode = it },
                    label = { Text("OTP code from email") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = newPassword,
                    onValueChange = { newPassword = it },
                    label = { Text("New password (12+ chars)") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = confirmPassword,
                    onValueChange = { confirmPassword = it },
                    label = { Text("Confirm password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Spacer(Modifier.height(20.dp))

            Button(
                onClick = { if (resetMode) { if (otpSent) completeReset() else sendOtp() } else signIn() },
                enabled = !loading && email.isNotBlank() && (resetMode || password.isNotBlank()),
                modifier = Modifier.fillMaxWidth().height(50.dp),
            ) {
                if (loading) CircularProgressIndicator(Modifier.width(22.dp).height(22.dp), strokeWidth = 2.dp)
                else Text(if (resetMode) (if (otpSent) "Set new password" else "Send OTP") else "Enter ${roles.first { it.first == role }.second} workspace")
            }

            if (resetMode) {
                TextButton(onClick = { resetMode = false; otpSent = false; error = null }) { Text("Back to sign in") }
            } else {
                Spacer(Modifier.height(8.dp))
                Text(
                    "Have an invitation? Create a student or faculty account on the web app.",
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}