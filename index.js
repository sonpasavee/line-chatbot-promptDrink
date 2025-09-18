const line = require('@line/bot-sdk')
const express = require('express')
const dotenv = require('dotenv')
const mongoose = require('mongoose')
const cron = require('node-cron')

const app = express()
dotenv.config()

// LINE config
const lineConfig = {
    channelAccessToken: process.env.ACCESS_TOKEN,
    channelSecret: process.env.SECRET_TOKEN
}

// create client
const client = new line.Client(lineConfig)

// connect MongoDB
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI)
        console.log("MongoDB Connected...")
    } catch (error) {
        console.error("MongoDB connection error:", error.message)
        process.exit(1)
    }
}
connectDB()

// Water schema
const waterSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    displayName: { type: String },
    dailyGoal: { type: Number, default: 2000 }, // ค่าเริ่มต้น 2000 ml
    reminders: { type: Number, default: 0 }, // แจ้งเตือนทุกกี่ชม.
    dailyIntake: [
        {
            amount: Number,
            time: { type: Date, default: Date.now }
        }
    ],
    createdAt: { type: Date, default: Date.now }
})
const Water = mongoose.model('Water', waterSchema)

// Webhook
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
    try {
        const events = req.body.events
        if (events.length > 0) {
            await Promise.all(events.map(item => handleEvent(item)))
        }
        res.status(200).send("OK")
    } catch (error) {
        console.error(error)
        res.status(500).end()
    }
})

// Handle Event
const handleEvent = async (event) => {
    const userId = event.source.userId

    // ดึงโปรไฟล์ LINE
    const profile = await client.getProfile(userId)

    // หา user ใน DB หรือสร้างใหม่
    let userData = await Water.findOne({ userId })
    if (!userData) {
        userData = new Water({
            userId,
            displayName: profile.displayName
        })
        await userData.save()
    }

    // ✅ Postback Event (เช่น กดเลือก reminder)
    if (event.type === "postback") {
        const data = event.postback.data
        const hours = parseInt(data, 10)
        if (!isNaN(hours)) {
            userData.reminders = hours
            await userData.save()
            return client.replyMessage(event.replyToken, {
                type: "text",
                text: `✅ บันทึกการแจ้งเตือนทุก ${hours} ชั่วโมงแล้วครับ`
            })
        }
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: `⚠️ ข้อมูลไม่ถูกต้อง`
        })
    }

    // ✅ Message Event
    if (event.type === 'message' && event.message.type === 'text') {
        const userMessage = event.message.text.trim()

        // ถ้าพิมพ์เป็นตัวเลข → บันทึกการดื่มน้ำ
        if (/^\d+$/.test(userMessage)) {
            const amount = parseInt(userMessage, 10)
            userData.dailyIntake.push({ amount })
            await userData.save()
            const total = userData.dailyIntake.reduce((a, b) => a + b.amount, 0)
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: `✅ คุณดื่มน้ำ ${amount} ml บันทึกแล้ว!\nปัจจุบันดื่มรวม ${total} / ${userData.dailyGoal} ml`
            })
        }

        // ตั้งเป้า goal
        if (userMessage.toLowerCase().startsWith("goal")) {
            const parts = userMessage.split(" ")
            if (parts[1]) {
                userData.dailyGoal = parseInt(parts[1], 10)
                await userData.save()
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `🎯 ตั้งเป้าหมายใหม่ ${userData.dailyGoal} ml ต่อวัน`
                })
            }
        }

        // แจ้งเตือน reminder → ส่ง Quick Reply
        if (userMessage.toLowerCase() === "reminder") {
            return client.replyMessage(event.replyToken, {
                type: "text",
                text: "⏰ เลือกช่วงเวลาที่ต้องการให้แจ้งเตือน",
                quickReply: {
                    items: [
                        {
                            type: "action",
                            action: { type: "postback", label: "ทุก 1 ชม.", data: "1" }
                        },
                        {
                            type: "action",
                            action: { type: "postback", label: "ทุก 2 ชม.", data: "2" }
                        },
                        {
                            type: "action",
                            action: { type: "postback", label: "ทุก 3 ชม.", data: "3" }
                        }
                    ]
                }
            })
        }

        // summary
        if (userMessage.toLowerCase() === "summary") {
            const total = userData.dailyIntake.reduce((a, b) => a + b.amount, 0)
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: `📊 สรุปวันนี้ คุณดื่มไปแล้ว ${total} / ${userData.dailyGoal} ml`
            })
        }

        // default response
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `สวัสดี ${profile.displayName} 👋\nพิมพ์ตามนี้ได้เลย:\n- ดื่มน้ำ: พิมพ์ตัวเลข เช่น "200"\n- ตั้งเป้า: goal <ml>\n- แจ้งเตือน: reminder\n- สรุป: summary`
        })
    }

    return null
}

app.listen(4000, () => {
    console.log("Listening on 4000")
})

cron.schedule("0 * * * *", async () => {
    console.log("Running hourly reminder job...")
    const now = new Date()
    const hour = now.getHours()

    // หา user ที่ตั้ง reminder > 0
    const users = await Water.find({ reminders: { $gt: 0 } })

    for (const user of users) {
        // ถ้าชั่วโมงปัจจุบัน % ชั่วโมงที่ตั้ง = 0 → ส่งแจ้งเตือน
        if (hour % user.reminders === 0) {
            await client.pushMessage(user.userId, {
                type: "text",
                text: `💧 ถึงเวลาดื่มน้ำแล้วครับ ${user.displayName}!`
            })
        }
    }
})
