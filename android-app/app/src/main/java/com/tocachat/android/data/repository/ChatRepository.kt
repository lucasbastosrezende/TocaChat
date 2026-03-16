package com.tocachat.android.data.repository

import androidx.compose.runtime.mutableStateMapOf
import com.tocachat.android.data.model.Conversation
import com.tocachat.android.data.model.Message

class ChatRepository {
    private val conversationMap = mutableStateMapOf<String, Conversation>().apply {
        putAll(
            linkedMapOf(
                "general" to Conversation(
                    id = "general",
                    title = "Geral",
                    lastMessagePreview = "Bem-vindo ao Toca Chat Android 👋",
                    messages = listOf(
                        Message("1", "Sistema", "Bem-vindo ao Toca Chat Android 👋", "09:00", false),
                        Message("2", "Você", "Vamos começar o MVP!", "09:02", true)
                    )
                ),
                "produto" to Conversation(
                    id = "produto",
                    title = "Produto",
                    lastMessagePreview = "Precisamos priorizar notificações push.",
                    messages = listOf(
                        Message("3", "Marina", "Precisamos priorizar notificações push.", "10:15", false)
                    )
                )
            )
        )
    }

    fun getConversations(): List<Conversation> = conversationMap.values.toList()

    fun getConversation(conversationId: String): Conversation =
        conversationMap[conversationId] ?: Conversation(
            id = conversationId,
            title = "Conversa",
            lastMessagePreview = "",
            messages = emptyList()
        )

    fun sendMessage(conversationId: String, content: String) {
        val target = conversationMap[conversationId] ?: return
        val newMessage = Message(
            id = System.currentTimeMillis().toString(),
            sender = "Você",
            content = content,
            timestamp = "agora",
            isMine = true
        )

        conversationMap[conversationId] = target.copy(
            lastMessagePreview = content,
            messages = target.messages + newMessage
        )
    }
}
