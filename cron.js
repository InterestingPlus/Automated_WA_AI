const cron = require("cron");
const https = require("https");

const job = new cron.CronJob("*/14 * * * *", function () {
  const hour = new Date().getHours();
  if (hour >= 7 && hour < 23) {
    https
      .get("https://automated-wa-ai.onrender.com", (res) => {
        if (res.statusCode === 200)
          console.log("!!✅!!GET Request sent Successfully!");
        else console.log("!!✅!!GET Request failed!", res.statusCode);
      })
      .on("error", (e) =>
        console.error("!!✅!!Error while Sending request", e)
      );
  } else {
    console.log("!!✅!!Skipping ping during inactive hours");
  }
});

module.exports = job;
