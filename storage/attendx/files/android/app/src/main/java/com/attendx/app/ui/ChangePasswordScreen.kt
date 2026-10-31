package com.attendx.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.attendx.app.api.Api
import com.attendx.app.api.ApiException
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun ChangePasswordScreen(api: Api, onDone: () -> Unit, onSignOut: () -> Unit) {
    val scope = rememberCoroutineScope()
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    fun submit() {
        scope.launch {
            loading = true; error = null
            try {
                if (password.length < 12) throw ApiException("Use at least 12 characters")
                if (password != confirm) throw ApiException("Passwords do not match")
                val res = api.request(
                    "/api/functions/change-own-password",
                    "POST",
                    JSONObject().put("password", password),
                )
                if (!res.ok) throw ApiException(res.errorMessage())
                onDone()
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Exception) {
                error = "Could not reach the server"
            }
            loading = false
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(48.dp))
        Text("Choose a private password", style = MaterialTheme.typography.titleLarge)
        Text(
            "The administrator-issued password can only be used to enter this screen. Replace it before continuing.",
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(vertical = 12.dp),
        )
        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(8.dp))
        }
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("New password (12+ chars)") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = confirm,
            onValueChange = { confirm = it },
            label = { Text("Confirm password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(18.dp))
        Button(onClick = { submit() }, enabled = !loading, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            Text(if (loading) "Updating…" else "Set password and continue")
        }
        TextButton(onClick = onSignOut) { Text("Sign out") }
    }
}