import { tool } from "ai";
import { z } from "zod";

export const getWeather = tool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => ({
    city,
    tempC: 21,
    condition: "partly cloudy",
  }),
});

export const lookupOrder = tool({
  description: "Look up the shipping status of a customer order by id.",
  inputSchema: z.object({ orderId: z.string().describe("The order id") }),
  execute: async ({ orderId }) => ({
    orderId,
    status: "in_transit",
    carrier: "FakeEx",
    eta: "2 days",
  }),
});

export const tools = { getWeather, lookupOrder };
