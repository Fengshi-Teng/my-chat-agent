// /**
//  * Tool definitions for the AI chat agent
//  * Tools can either require human confirmation or execute automatically
//  */
// import { tool, type ToolSet } from "ai";
// import { z } from "zod/v3";

// import type { Chat } from "./server";
// import { getCurrentAgent } from "agents";
// import { scheduleSchema } from "agents/schedule";

// /**
//  * Weather information tool that requires human confirmation
//  * When invoked, this will present a confirmation dialog to the user
//  */
// const getWeatherInformation = tool({
//   description: "show the weather in a given city to the user",
//   inputSchema: z.object({ city: z.string() })
//   // Omitting execute function makes this tool require human confirmation
// });

// /**
//  * Local time tool that executes automatically
//  * Since it includes an execute function, it will run without user confirmation
//  * This is suitable for low-risk operations that don't need oversight
//  */
// const getLocalTime = tool({
//   description: "get the local time for a specified location",
//   inputSchema: z.object({ location: z.string() }),
//   execute: async ({ location }) => {
//     console.log(`Getting local time for ${location}`);
//     return "10am";
//   }
// });

// const scheduleTask = tool({
//   description: "A tool to schedule a task to be executed at a later time",
//   inputSchema: scheduleSchema,
//   execute: async ({ when, description }) => {
//     // we can now read the agent context from the ALS store
//     const { agent } = getCurrentAgent<Chat>();

//     function throwError(msg: string): string {
//       throw new Error(msg);
//     }
//     if (when.type === "no-schedule") {
//       return "Not a valid schedule input";
//     }
//     const input =
//       when.type === "scheduled"
//         ? when.date // scheduled
//         : when.type === "delayed"
//           ? when.delayInSeconds // delayed
//           : when.type === "cron"
//             ? when.cron // cron
//             : throwError("not a valid schedule input");
//     try {
//       agent!.schedule(input!, "executeTask", description);
//     } catch (error) {
//       console.error("error scheduling task", error);
//       return `Error scheduling task: ${error}`;
//     }
//     return `Task scheduled for type "${when.type}" : ${input}`;
//   }
// });

// /**
//  * Tool to list all scheduled tasks
//  * This executes automatically without requiring human confirmation
//  */
// const getScheduledTasks = tool({
//   description: "List all tasks that have been scheduled",
//   inputSchema: z.object({}),
//   execute: async () => {
//     const { agent } = getCurrentAgent<Chat>();

//     try {
//       const tasks = agent!.getSchedules();
//       if (!tasks || tasks.length === 0) {
//         return "No scheduled tasks found.";
//       }
//       return tasks;
//     } catch (error) {
//       console.error("Error listing scheduled tasks", error);
//       return `Error listing scheduled tasks: ${error}`;
//     }
//   }
// });

// /**
//  * Tool to cancel a scheduled task by its ID
//  * This executes automatically without requiring human confirmation
//  */
// const cancelScheduledTask = tool({
//   description: "Cancel a scheduled task using its ID",
//   inputSchema: z.object({
//     taskId: z.string().describe("The ID of the task to cancel")
//   }),
//   execute: async ({ taskId }) => {
//     const { agent } = getCurrentAgent<Chat>();
//     try {
//       await agent!.cancelSchedule(taskId);
//       return `Task ${taskId} has been successfully canceled.`;
//     } catch (error) {
//       console.error("Error canceling scheduled task", error);
//       return `Error canceling task ${taskId}: ${error}`;
//     }
//   }
// });

// /**
//  * Export all available tools
//  * These will be provided to the AI model to describe available capabilities
//  */
// export const tools = {
//   getWeatherInformation,
//   getLocalTime,
//   scheduleTask,
//   getScheduledTasks,
//   cancelScheduledTask
// } satisfies ToolSet;

// /**
//  * Implementation of confirmation-required tools
//  * This object contains the actual logic for tools that need human approval
//  * Each function here corresponds to a tool above that doesn't have an execute function
//  */
// export const executions = {
//   getWeatherInformation: async ({ city }: { city: string }) => {
//     console.log(`Getting weather information for ${city}`);
//     return `The weather in ${city} is sunny`;
//   }
// };



/**
 * Tool definitions for the AI chat agent
 * Tools can either require human confirmation or execute automatically
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod/v3";

import type { Chat } from "./server";
import { getCurrentAgent } from "agents";
// import { scheduleSchema } from "agents/schedule";



// ===== Bond / Treasury Helpers =====

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function toUTCDate(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function diffInDays(start: Date, end: Date): number {
  const s = toUTCDate(start).getTime();
  const e = toUTCDate(end).getTime();
  return Math.round((e - s) / MS_PER_DAY);
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const targetMonth = d.getMonth() + months;
  d.setMonth(targetMonth);
  return d;
}

/**
 * T+1 settlement for Treasuries, skipping weekends.
 * (Ignores holidays; add them if you want.)
 */
function nextSettlementDateFromTrade(tradeDate: Date): Date {
  const d = new Date(tradeDate);
  d.setDate(d.getDate() + 1); // T+1

  // Saturday -> Monday
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  // Sunday -> Monday
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);

  return d;
}

/**
 * For U.S. Treasuries: assume semiannual coupons (2 per year),
 * payments every 6 months on the same DOM as maturity.
 */
function getCouponPeriod(
  settlement: Date,
  maturity: Date,
  frequency: number = 2
): { lastCoupon: Date; nextCoupon: Date } {
  const stepMonths = 12 / frequency;
  let nextCoupon = toUTCDate(maturity);
  let lastCoupon = addMonths(nextCoupon, -stepMonths);

  while (settlement < lastCoupon) {
    nextCoupon = lastCoupon;
    lastCoupon = addMonths(lastCoupon, -stepMonths);
  }

  return { lastCoupon, nextCoupon };
}

type TreasuryAccruedResult = {
  f: number;
  daysSinceLastCoupon: number;
  daysInPeriod: number;
  couponPerPeriod: number;
  accruedInterest: number;
  dirtyPrice: number;
};

function calculateAccruedTreasury(params: {
  maturityDateStr: string;
  marketRatePct: number;   // coupon rate in %
  cleanPrice: number;      // EOD clean price per 100
  settlementDateStr: string;
  faceValue?: number;
}): TreasuryAccruedResult {
  const {
    maturityDateStr,
    marketRatePct,
    cleanPrice,
    settlementDateStr,
    faceValue = 100
  } = params;

  const maturityDate = new Date(maturityDateStr);
  const settlementDate = new Date(settlementDateStr);

  const frequency = 2; // semiannual
  const { lastCoupon, nextCoupon } = getCouponPeriod(
    settlementDate,
    maturityDate,
    frequency
  );

  const daysSinceLastCoupon = diffInDays(lastCoupon, settlementDate);
  const daysInPeriod = diffInDays(lastCoupon, nextCoupon);
  const f = daysSinceLastCoupon / daysInPeriod;

  const couponRate = marketRatePct / 100;
  const couponPerPeriod = (couponRate * faceValue) / frequency;
  const accruedInterest = couponPerPeriod * f;

  const dirtyPrice = cleanPrice + accruedInterest * (100 / faceValue);

  return {
    f,
    daysSinceLastCoupon,
    daysInPeriod,
    couponPerPeriod,
    accruedInterest,
    dirtyPrice
  };
}



const calculateTreasuryMetrics = tool({
  description:
    "Calculate dirty price and accrued interest for US Treasuries using D1. Bills return EOD dirty price; notes/bonds compute accrued interest.",
  inputSchema: z.object({
    cusip: z.string().describe("Treasury CUSIP")
  }),

  execute: async ({ cusip }) => {
    const { agent } = getCurrentAgent<Chat>();
    const env = agent?.env as Env;
    const db = env.DB;
    if (!db) throw new Error("Missing D1 binding DB");

    // ===== Fixed settlement date =====
    const settlementStr = "2025-11-18";

    // ===== Fetch required fields from D1 =====
    const stmt = db
      .prepare(
        `
        SELECT 
          cusip,
          security_type,
          rate,
          maturity_date,
          end_of_day
        FROM prices111825
        WHERE cusip = ?
        `
      )
      .bind(cusip);

    const row = await stmt.first<{
      cusip: string;
      security_type: string;
      rate: number;
      maturity_date: string;
      clean_price: number;
      end_of_day: number;
    }>();

    if (!row) throw new Error(`CUSIP ${cusip} not found.`);

    // ===== Case 1: MARKET BASED BILL → dirty = end_of_day =====
    if (row.security_type === "MARKET BASED BILL") {
      return {
        cusip: row.cusip,
        type: row.security_type,
        maturityDate: row.maturity_date,
        settlementDate: settlementStr,
        dirtyPrice: row.end_of_day,
        message: `This is a Treasury Bill. Dirty price = END_OF_DAY = ${row.end_of_day}`
      };
    }

    // ===== Case 2: Note / Bond =====
    const result = calculateAccruedTreasury({
      maturityDateStr: row.maturity_date,
      marketRatePct: row.rate,
      cleanPrice: row.clean_price,
      settlementDateStr: settlementStr
    });

    const dirty = row.end_of_day + result.accruedInterest;

    return {
      cusip: row.cusip,
      type: row.security_type,
      maturityDate: row.maturity_date,
      settlementDate: settlementStr,
      cleanPrice: row.clean_price,
      accruedInterest: result.accruedInterest,
      dirtyPrice: dirty,
      daysSinceLastCoupon: result.daysSinceLastCoupon,
      daysInPeriod: result.daysInPeriod,
      message: [
        `(${row.security_type})`,
        `Settlement = ${settlementStr}`,
        `Clean = ${row.clean_price}`,
        `Accrued interest = ${result.accruedInterest.toFixed(6)}`,
        `Dirty = clean + accrued = ${dirty.toFixed(6)}`
      ].join("\n")
    };
  }
});




/**
 * Export all available tools
 * These will be provided to the AI model to describe available capabilities
 */
export const tools = {
  calculateTreasuryMetrics  
} satisfies ToolSet;


/**
 * Implementation of confirmation-required tools
 * This object contains the actual logic for tools that need human approval
 * Each function here corresponds to a tool above that doesn't have an execute function
 */
export const executions = {
  getWeatherInformation: async ({ city }: { city: string }) => {
    console.log(`Getting weather information for ${city}`);
    return `The weather in ${city} is sunny`;
  }
};






