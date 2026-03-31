# MemoryVerse

MemoryVerse is a small web app for practicing Bible passages in a research-informed memorization flow.

## Run

```bash
npm start
```

Then open `http://127.0.0.1:3000`.

## Memorization Method

The app currently uses a single study mode:

- Break the passage into smaller clause-sized chunks.
- Show one chunk in full, then switch into ordered retrieval of that chunk.
- Start chunk recall with first-letter cues, then remove those cues on later successful recalls.
- Require repeated successful recall for each chunk before considering it learned.
- Revisit previously cleared chunks later in the same session instead of finishing them once and moving on forever.
- Finish with whole-passage consolidation, first with cues and then with blank-only recall.
- Keep answers word-by-word and in order, with immediate feedback after each response.

The exact chunk size, `3`-success chunk criterion, and within-session revisit schedule are implementation inferences from the research below rather than direct copies of one published protocol.

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
