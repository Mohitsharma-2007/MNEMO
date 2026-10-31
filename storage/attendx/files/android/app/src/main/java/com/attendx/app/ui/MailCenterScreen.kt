package com.attendx.app.ui

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.attendx.app.api.Api
import com.attendx.app.api.ApiException
import com.attendx.app.api.Session
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

data class NoticeType(val type: String, val label: String, val audience: String)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MailCenterScreen(api: Api, session: Session, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var types by remember { mutableStateOf<List<NoticeType>>(emptyList()) }
    var notices by remember { mutableStateOf<JSONArray>(JSONArray()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    var selectedType by remember { mutableStateOf("") }
    var subject by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var trackQuery by remember { mutableStateOf("") }
    var lastTracking by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    var typeExpanded by remember { mutableStateOf(false) }

    fun loadList(tracking: String? = null) {
        scope.launch {
            loading = true; error = null
            try {
                notices = api.listNotices(trackingId = tracking)
            } catch (e: Exception) {
                error = e.message
            }
            loading = false
        }
    }

    fun refresh() {
        scope.launch {
            loading = true; error = null
            try {
                val cat = api.catalog()
                val all = cat.optJSONArray("types") ?: JSONArray()
                val list = mutableListOf<NoticeType>()
                for (i in 0 until all.length()) {
                    val t = all.getJSONObject(i)
                    if (session.role == "admin" || t.optString("audience") == "system") {
                        list.add(NoticeType(t.optString("type"), t.optString("label"), t.optString("audience")))
                    }
                }
                types = list
                if (selectedType.isEmpty() && list.isNotEmpty()) selectedType = list.first().type
                notices = api.listNotices()
            } catch (e: Exception) {
                error = e.message
            }
            loading = false
        }
    }

    fun raise() {
        scope.launch {
            sending = true; error = null
            try {
                val created = api.raiseNotice(selectedType, subject, message)
                lastTracking = created.optString("tracking_id").ifEmpty { created.optString("trackingId") }
                subject = ""; message = ""
                notices = api.listNotices()
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Exception) {
                error = "Could not reach the server"
            }
            sending = false
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Column(modifier = modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Mail Center", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Raise requests, complaints and enquiries — every request gets a tracking number and a confirmation email.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(16.dp))

        lastTracking?.let {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    Text("Request raised ✓", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                    Text("Your request number is $it. Keep it to track this request.", style = MaterialTheme.typography.bodySmall)
                }
            }
            Spacer(Modifier.height(12.dp))
        }

        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(8.dp))
        }

        if (types.isNotEmpty()) {
            ExposedDropdownMenuBox(expanded = typeExpanded, onExpandedChange = { typeExpanded = it }) {
                OutlinedTextField(
                    value = types.firstOrNull { it.type == selectedType }?.label ?: selectedType,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("Request type") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = typeExpanded) },
                    modifier = Modifier.fillMaxWidth().menuAnchor().padding(bottom = 12.dp),
                )
                ExposedDropdownMenu(expanded = typeExpanded, onDismissRequest = { typeExpanded = false }) {
                    types.forEach { t ->
                        DropdownMenuItem(text = { Text(t.label) }, onClick = { selectedType = t.type; typeExpanded = false })
                    }
                }
            }

            OutlinedTextField(
                value = subject,
                onValueChange = { subject = it },
                label = { Text("Subject") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                value = message,
                onValueChange = { message = it },
                label = { Text("Message") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = { raise() },
                enabled = !sending && subject.isNotBlank() && message.isNotBlank() && selectedType.isNotEmpty(),
                modifier = Modifier.fillMaxWidth().height(46.dp),
            ) {
                if (sending) CircularProgressIndicator(Modifier.width(20.dp).height(20.dp), strokeWidth = 2.dp)
                else Text("Raise request")
            }
            Spacer(Modifier.height(8.dp))
            HorizontalDivider()
            Spacer(Modifier.height(12.dp))
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = trackQuery,
                onValueChange = { trackQuery = it },
                label = { Text("Track by request number") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = { loadList(trackQuery.trim()) }) { Text("Track") }
        }
        Spacer(Modifier.height(12.dp))

        Text("Requests", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(6.dp))
        if (loading) {
            CircularProgressIndicator(Modifier.padding(20.dp))
        } else if (notices.length() == 0) {
            Text("No requests yet.", style = MaterialTheme.typography.bodySmall)
        } else {
            for (i in 0 until notices.length()) {
                val n = notices.getJSONObject(i)
                Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(n.optString("tracking_id").ifEmpty { n.optString("trackingId") }, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                            Text(n.optString("status"), style = MaterialTheme.typography.labelSmall)
                        }
                        Text(n.optString("subject"), fontWeight = FontWeight.SemiBold)
                        Text(n.optString("message"), style = MaterialTheme.typography.bodySmall)
                        Text(
                            n.optString("created_at").substringBefore("T"),
                            style = MaterialTheme.typography.labelSmall,
                        )
                        if (session.role == "admin" && n.optString("status") == "open") {
                            TextButton(onClick = {
                                scope.launch {
                                    try {
                                        api.resolveNotice(n.optString("id"), "resolved", "Resolved from the Android app")
                                        notices = api.listNotices()
                                    } catch (_: Exception) {}
                                }
                            }) { Text("Mark resolved") }
                        }
                    }
                }
            }
        }
    }
}