package com.attendx.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.attendx.app.api.Api
import com.attendx.app.api.Session
import kotlinx.coroutines.launch

@Composable
fun ProfileScreen(
    api: Api,
    session: Session,
    onSignOut: () -> Unit,
    onMustChangePassword: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var serverUrl by remember { mutableStateOf(api.serverUrl) }
    var testing by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<String?>(null) }

    fun testServer() {
        scope.launch {
            testing = true; testResult = null
            api.serverUrl = serverUrl
            val health = api.health()
            val db = health.optString("database").ifEmpty { "unknown" }
            testResult = if (health.optString("status") == "ok") "Connected — database: $db" else "Server responded but is unhealthy"
            testing = false
        }
    }

    Column(modifier = modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Profile", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(14.dp))

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text(session.fullName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(session.email, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(8.dp))
                Text("Role: ${session.role}", style = MaterialTheme.typography.bodySmall)
                Text("ID: ${session.identifier.ifBlank { "—" }}", style = MaterialTheme.typography.bodySmall)
                Text("Department: ${session.department.ifBlank { "—" }}", style = MaterialTheme.typography.bodySmall)
            }
        }

        Spacer(Modifier.height(16.dp))
        HorizontalDivider()
        Spacer(Modifier.height(12.dp))

        Text("Server connection", style = MaterialTheme.typography.titleMedium)
        Text("The app can talk to the AttendX cloud or your institution's LAN server.", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            label = { Text("Server URL") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(10.dp))
        Row {
            Button(onClick = { testServer() }, enabled = !testing && serverUrl.isNotBlank()) {
                if (testing) CircularProgressIndicator(Modifier.height(18.dp).width(18.dp), strokeWidth = 2.dp)
                else Text("Test & save")
            }
        }
        testResult?.let {
            Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        }

        Spacer(Modifier.height(16.dp))
        HorizontalDivider()
        Spacer(Modifier.height(12.dp))

        TextButton(onClick = onMustChangePassword) { Text("Change password") }
        Spacer(Modifier.height(6.dp))
        Button(onClick = onSignOut, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            Text("Sign out")
        }
        Spacer(Modifier.height(8.dp))
        Text("AttendX 2.0.0 · Institutional attendance infrastructure", style = MaterialTheme.typography.labelSmall)
    }
}