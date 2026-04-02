# MemoryVerse

MemoryVerse is a small web app for practicing Bible passages in a research-informed memorization flow.

## Run

```bash
npm start
```

Then open `http://127.0.0.1:3000`.

## Translation Setup

The app supports `NLT`, `ESV`, `NIV`, `KJV`, and `NLTUK`.

- `NLT`, `KJV`, and `NLTUK` use the NLT API. If you do not set `NLT_API_KEY`, the app falls back to the provider's `TEST` key.
- `ESV` requires `ESV_API_KEY`.
- `NIV` requires `API_BIBLE_KEY`, and that key must have access to an NIV Bible in API.Bible.
- `NIV_BIBLE_ID` is optional. Set it if you want to pin a specific NIV Bible instead of letting the server auto-detect one.

Example:

```bash
NLT_API_KEY=your-nlt-key \
ESV_API_KEY=your-esv-key \
API_BIBLE_KEY=your-api-bible-key \
npm start
```

## Memorization Method

The app currently uses a single study mode:

- Break the passage into clause-sized chunks, but merge any one-word chunk into a neighbor so chunks stay at two words or more when possible.
- For every line in the study plan, do exactly three steps:
  `Study -> letter cues -> blank only`
- Build the study plan recursively from left to right:
  first learn small neighboring chunks, then merge those neighboring groups into a larger line, then keep repeating that process until the whole passage has been covered.
- While a line is active, show one chunk of greyed-out context before it and one chunk after it when available.
- Mark the start of each verse in the passage card with a superscript verse number.
- After the last full-passage line is finished, repeat the final blank-only full-passage test until you complete a clean run.
- Keep answers word-by-word and in order, with immediate feedback after each response.

If a passage has ten chunks, and `T` stands for chunk `10`, the recursive study plan is:

```text
1
2
12
3
123
4
5
45
6
456
123456
7
8
78
9
789
123456789
T
123456789T
```

That means the app first learns small adjacent pieces, then immediately rehearses the merged version of those same pieces, so long passages grow in manageable steps instead of waiting until the end for one giant merge.

The exact chunk boundaries and this specific recursive merge pattern are implementation inferences from the research below rather than direct copies of one published protocol.

## Research Used

- Roediger, H. L., & Karpicke, J. D. (2006). *Test-enhanced learning: Taking memory tests improves long-term retention.* Psychological Science, 17(3), 249-255.
  https://pubmed.ncbi.nlm.nih.gov/16507066/
- Karpicke, J. D., & Blunt, J. R. (2011). *Retrieval practice produces more learning than elaborative studying with concept mapping.* Science, 331(6018), 772-775.
  https://pubmed.ncbi.nlm.nih.gov/21252317/
- Butler, A. C., Karpicke, J. D., & Roediger, H. L. (2008). *Correcting a metacognitive error: Feedback increases retention of low-confidence correct responses.* Journal of Experimental Psychology: Learning, Memory, and Cognition, 34(4), 918-928.
  https://pubmed.ncbi.nlm.nih.gov/18605878/
- Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006). *Distributed practice in verbal recall tasks: A review and quantitative synthesis.* Psychological Bulletin, 132(3), 354-380.
  https://pubmed.ncbi.nlm.nih.gov/16719566/
- Renkl, A., Atkinson, R. K., & Große, C. S. (2004). *How fading worked solution steps works: A cognitive load perspective.* Instructional Science, 32, 59-82.
  https://link.springer.com/article/10.1023/B:TRUC.0000021815.74806.f6
- Mayer, R. E. (2009). *Segmenting Principle.* In *Multimedia Learning*.
  https://doi.org/10.1017/CBO9780511811678.013
- Dunlosky, J., Rawson, K. A., Marsh, E. J., Nathan, M. J., & Willingham, D. T. (2013). *Improving students' learning with effective learning techniques: Promising directions from cognitive and educational psychology.* Psychological Science in the Public Interest, 14(1), 4-58.
  https://pubmed.ncbi.nlm.nih.gov/26173288/
- Rawson, K. A., & Dunlosky, J. (2022). *Successive relearning: An underexplored but potent technique for obtaining and maintaining knowledge.* Current Directions in Psychological Science, 31(4), 362-368.
  https://doi.org/10.1177/09637214221100484
