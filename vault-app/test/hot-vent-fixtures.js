// Slice 19 real-heat fixtures (synthetic Alex). Shared by the memory and PG legs.

export const ROUND_TWO =
  "I am so fucking done. She is a narcissist who is alienating the kids and I want to tell her off for cancelling my weekend again.";

export const FIXTURES = {
  swearing:
    "This is such bullshit. She was late to the exchange again, 45 minutes, and I am so damn sick of waiting in that fucking parking lot.",
  diagnosis:
    "She is a narcissist and she is alienating the kids on purpose. She never tells me anything about the kids' school, she wants to control everything.",
  tell_off:
    "I swear I am going to tell her off tonight. She cancelled my visit with the kids on Saturday with one hour notice.",
  cancelled_time:
    "She cancelled my parenting time AGAIN. Third weekend in a row. Hell no, I am done being nice.",
  request_in_anger:
    "I am so sick of her crap. She never tells me anything. I need her to send me the dentist appointment dates for October, for god's sake.",
};

// Slice 19b — five more real-heat fixtures (widen), verbatim.
export const FIXTURES_19B = {
  c1_poisoning:
    "She's poisoning them against me, I know it. The kids came back from her place saying I never pay for anything, which is a lie, I've paid every single support payment on time for two years.",
  c2_schedule:
    "I'm losing my mind. She scheduled the boys' soccer for my weekends on purpose so I look like the bad guy when I say no. I need the fall schedule she's been hiding from me.",
  c3_safety:
    "Absolutely not. She showed up drunk to the exchange on Friday the 25th with the kids in the car and I am not letting that slide this time.",
  c4_defeat:
    "Whatever. Fine. She can do what she wants I guess, nobody listens to me anyway.",
  c5_money:
    "She spent the kids' college money on a vacation and I want it documented that she took four thousand dollars out of the 529 in September without telling me.",
};

// The exact expected output for all 10 (5 Slice 19 + 5 Slice 19b).
export const EXPECTED = {
  swearing: "The exchange started late. Please confirm the exchange time for next time. Thank you.",
  diagnosis: "I haven't received the kids' school information. Please send me the school information. Thank you.",
  tell_off: "My visit with the kids was cancelled. Please let me know when we can schedule the make-up time. Thank you.",
  cancelled_time: "My weekend parenting time was cancelled again. Please let me know when we can schedule the make-up time. Thank you.",
  request_in_anger:
    "I haven't received the kids' dentist appointment information. Please send me the dentist appointment dates for October. Thank you.",
  c1_poisoning:
    "The kids came back repeating things about money and support. Please keep adult topics like support between us and away from the kids. Thank you.",
  c2_schedule: "The boys' soccer is scheduled during my weekends. Please send me the fall schedule. Thank you.",
  c3_safety: null, // no draft — safety say
  c4_defeat: null, // no draft — worn-out say
  c5_money:
    "I learned that four thousand dollars was taken out of the kids' 529 account in September. Please send me the 529 account statement for September and let me know what the withdrawal was for. Thank you.",
};
