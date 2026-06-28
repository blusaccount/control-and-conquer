import type { MapDefinition } from "../types.js";

/**
 * The original 8-polygon launch map, now expressed as data. Kept as the
 * built-in default so the engine (and tests) always has a valid map without
 * touching the filesystem.
 */
export const CONQUEROR_BASIN: MapDefinition = {
  name: "Conqueror Basin",
  territories: [
    {
      id: "north-west",
      name: "North West",
      ownerId: "blue",
      troops: 14,
      neighbors: ["north-center", "west"],
      polygon: [
        { x: 38, y: 42 },
        { x: 214, y: 30 },
        { x: 205, y: 138 },
        { x: 56, y: 162 },
      ],
    },
    {
      id: "north-center",
      name: "North Center",
      ownerId: "blue",
      troops: 12,
      neighbors: ["north-west", "north-east", "center", "west"],
      polygon: [
        { x: 214, y: 30 },
        { x: 388, y: 42 },
        { x: 372, y: 162 },
        { x: 205, y: 138 },
      ],
    },
    {
      id: "north-east",
      name: "North East",
      ownerId: "red",
      troops: 13,
      neighbors: ["north-center", "east", "center"],
      polygon: [
        { x: 388, y: 42 },
        { x: 690, y: 74 },
        { x: 664, y: 208 },
        { x: 372, y: 162 },
      ],
    },
    {
      id: "west",
      name: "West Basin",
      ownerId: "blue",
      troops: 11,
      neighbors: ["north-west", "north-center", "center", "south-west"],
      polygon: [
        { x: 56, y: 162 },
        { x: 205, y: 138 },
        { x: 224, y: 272 },
        { x: 78, y: 326 },
        { x: 40, y: 260 },
      ],
    },
    {
      id: "center",
      name: "Central Crossing",
      ownerId: "red",
      troops: 16,
      neighbors: ["north-center", "north-east", "west", "east", "south-west", "south-east"],
      polygon: [
        { x: 205, y: 138 },
        { x: 372, y: 162 },
        { x: 418, y: 300 },
        { x: 282, y: 340 },
        { x: 224, y: 272 },
      ],
    },
    {
      id: "east",
      name: "East Reach",
      ownerId: "red",
      troops: 10,
      neighbors: ["north-east", "center", "south-east"],
      polygon: [
        { x: 372, y: 162 },
        { x: 664, y: 208 },
        { x: 626, y: 354 },
        { x: 418, y: 300 },
      ],
    },
    {
      id: "south-west",
      name: "South West",
      ownerId: "blue",
      troops: 9,
      neighbors: ["west", "center", "south-east"],
      polygon: [
        { x: 78, y: 326 },
        { x: 224, y: 272 },
        { x: 282, y: 340 },
        { x: 232, y: 396 },
        { x: 96, y: 404 },
      ],
    },
    {
      id: "south-east",
      name: "South East",
      ownerId: "red",
      troops: 9,
      neighbors: ["south-west", "center", "east"],
      polygon: [
        { x: 282, y: 340 },
        { x: 418, y: 300 },
        { x: 626, y: 354 },
        { x: 588, y: 430 },
        { x: 312, y: 422 },
        { x: 232, y: 396 },
      ],
    },
  ],
};
